'use strict'

var Rx = require('rx')
var RxNode = require('rx-node')
var R = require('ramda')
var PassThrough = require('readable-stream/passthrough')
var split = require('split')
var duplexer = require('duplexer')
var jsYaml = require('js-yaml')

var O = Rx.Observable

var TEST = 'TEST'
var ASSERTION = 'ASSERTION'
var PLAN = 'PLAN'
var VERSION = 'VERSION'
var COMMENT_BLOCK_START = 'COMMENT_BLOCK_START'
var COMMENT_BLOCK_END = 'COMMENT_BLOCK_END'
var COMMENT = 'COMMENT'
var RESULT = 'RESULT'
var TODO = 'TODO'

var COMMENT_BLOCK_PADDING_SIZE = 2

var REGEXES = {
  assertion: new RegExp('^(not )?ok\\b(?:(?:\\s+(\\d+))?(?:\\s+(?:(?:\\s*-\\s*)?(.*)))?)?'),
  result: new RegExp('(#)(\\s+)((?:[a-z][a-z]+))(\\s+)(\\d+)',['i']),
  plan: /^(\d+)\.\.(\d+)\b(?:\s+#\s+SKIP\s+(.*)$)?/,
  test: /^#\s*(.+)/,
  version: /^TAP\s+version\s+(\d+)/i,
  todo: /^(.*?)\s*#\s*TODO\s+(.*)$/,
  skip: /^(.*?)\s*#\s*TODO\s+(.*)$/
}

var removeCommentBlockPadding = R.map(R.drop(COMMENT_BLOCK_PADDING_SIZE))
var parseYamlBlock = R.pipe(
  removeCommentBlockPadding,
  R.join('\n'),
  jsYaml.safeLoad
)

module.exports = {
  stream: function () {

    var input = new PassThrough()
    var output = new PassThrough()
    var returnStream = duplexer(input, output)
    var tap$ = RxNode.fromStream(input.pipe(split()))

    RxNode.writeToStream(parse$(tap$).map(JSON.stringify), output)

    return returnStream
  },

  // TODO: not completely happy about this name for the method
  observeStream: function (stream) {

    var input$ = RxNode.fromStream(stream.pipe(split()))
    return parse$(input$)
  }
}

function parse$ (tap$) {

  var plans$ = getPlans$(tap$)
  var versions$ = getVerions$(tap$)
  var tests$ = getTests$(tap$)
  var assertions$ = getAssertions$(tap$)
  var comments$ = getComments$(tap$)
  var passingAssertions$ = assertions$.filter(function (a) { return a.ok })
  var failingAssertions$ = assertions$.filter(function (a) { return !a.ok })
  var results$ = O.merge(
    getResult$('tests', assertions$),
    getResult$('pass', passingAssertions$),
    getResult$('fail', failingAssertions$)
  )
  var all$ = O
    .merge(
      tests$,
      assertions$,
      comments$,
      plans$,
      versions$,
      results$
    )

  all$.tests$ = tests$
  all$.assertions$ = assertions$
  all$.plans$ = plans$
  all$.versions$ = versions$
  all$.comments$ = comments$
  all$.results$ = results$
  all$.passingAssertions$ = passingAssertions$
  all$.failingAssertions$ = failingAssertions$

  return all$
}

function getResult$ (name, input$) {

  return input$
    .scan(function (prev) {return prev + 1}, 0)
    .last()
    .map(function (count) {

      return {
        type: 'result',
        name: name,
        count: count,
        raw: '# ' + name + ' ' + count
      }
    })
}

function getAssertions$ (input$) {

  var formattedLines$ = getGroupedLines$(input$)
  var tests$ = getTests$(input$)
  var assertions$ = getRawAssertions$(formattedLines$)
  var commentBlockStart$ = getCommentBlockStart$(formattedLines$)
  var commentBlockEnd$ = getCommentBlockEnd$(formattedLines$)
  var commentBlocks$ = getCommentBlocks$(formattedLines$, commentBlockStart$, commentBlockEnd$)

  return getFormattedAssertions$(assertions$, commentBlocks$, tests$)
}

function getTests$ (input$) {

  var formattedLines$ = getGroupedLines$(input$)
  return getFormattedTests$(formattedLines$)
}

function getComments$ (input$) {

  var parsingCommentBlock = false
  var formattedLines$ = getGroupedLines$(input$)
  var commentBlockStart$ = getCommentBlockStart$(formattedLines$)
  var commentBlockEnd$ = getCommentBlockEnd$(formattedLines$)

  commentBlockStart$.forEach(function () {parsingCommentBlock = true})
  commentBlockEnd$.forEach(function () {parsingCommentBlock = false})

  return formattedLines$
    .filter(function (line) {

      if (
        parsingCommentBlock
        || isTest(line.current.raw)
        || isAssertion(line.current.raw)
        || isVersion(line.current.raw)
        || isCommentBlockStart(line.current.raw)
        || isCommentBlockEnd(line.current.raw)
        || isPlan(line.current.raw)
        || isResult(line.current.raw)
        || isOk(line.current.raw)
        || line.current.raw === ''
      ) {
        return false
      }

      return true
    })
    .map(formatCommentObject)
}

function getPlans$ (input$) {

  return input$
    .filter(isPlan)
    .map(formatPlanObject)
}

function getVerions$ (input$) {

  return input$
    .filter(isVersion)
    .map(formatVersionObject)
}

function getGroupedLines$ (input$) {

  return input$
    .pairwise()
    .map(formatLinePair)
}

function getRawAssertions$ (input$) {

  return input$
    .filter(R.pipe(
      R.path(['current', 'type']),
      R.equals(ASSERTION)
    ))
    .map(function (line, index) {

      line.current.assertionNumber = index + 1
      line.next.assertionNumber = index + 2
      return line
    })
}

function getCommentBlockStart$ (input$) {

  return input$
    .filter(R.pipe(
      R.path(['current', 'type']),
      R.equals(COMMENT_BLOCK_START)
    ))
}

function getCommentBlockEnd$ (input$) {

  return input$
    .filter(R.pipe(
      R.path(['current', 'type']),
      R.equals(COMMENT_BLOCK_END)
    ))
}

function getAssertionsWithComments (assertions$, blocks$) {

  return assertions$
    .filter(R.pipe(
      R.path(['next', 'type']),
      R.equals(COMMENT_BLOCK_START)
    ))
    .flatMap(function (line) {

      return blocks$.take(1)
        .map(function (rawDiagnostic) {

          return {
            raw: line.current.raw,
            lineNumber: line.current.number,
            assertionNumber: line.current.assertionNumber,
            diagnostic: parseYamlBlock(rawDiagnostic),
            rawDiagnostic: rawDiagnostic
          }
        })
    })
}

function getCommentBlocks$ (formattedLines$, start$, end$) {

  var parsingCommentBlock = false
  var currentCommentBlock = []
  var formatBlock = R.pipe(
    R.map(R.path(['current', 'raw'])),
    R.flatten
  )

  formattedLines$
    .forEach(function (line) {

      if (parsingCommentBlock) {
        currentCommentBlock.push(line)
      }
      else {
        currentCommentBlock = []
      }
    })

  start$
    .forEach(function (line) {

      currentCommentBlock = [line]
      parsingCommentBlock = true
    })

  return  end$
    .map(function () {

      parsingCommentBlock = false
      return formatBlock(currentCommentBlock)
    })
}

function getFormattedTests$ (input$) {

  return input$
    .filter(R.pipe(
      R.path(['current', 'type']),
      R.equals(TEST)
    ))
    .map(function (line, index) {

      return formatTestObject(line.current.raw, line.current.number, index + 1)
    })
}

function getFormattedAssertions$ (assertions$, commentBlocks$, tests$) {

  var currentTestNumber = 0
  var assertionsWithComments$ = getAssertionsWithComments(assertions$, commentBlocks$)

  tests$.forEach(function (line) {currentTestNumber = line.testNumber})

  return assertions$
    .filter(R.pipe(
      R.path(['next', 'type']),
      R.complement(R.equals(COMMENT_BLOCK_START))
    ))
    .map(function (line) {

      var formattedLine = R.pipe(
        R.path(['current']),
        R.pick(['raw']),
        R.merge({
          lineNumber: line.current.number,
          assertionNumber: line.current.assertionNumber,
          diagnostic: {}
        })
      )(line)

      return formattedLine
    })
    .merge(assertionsWithComments$)
    .map(function (line) {

      return formatAssertionObject(line, currentTestNumber)
    })
}

function formatLinePair (pair, index) {

  return {
    current: {
      raw: pair[0],
      type: getLineType(pair[0]),
      number: index
    },
    next: {
      raw: pair[1],
      type: getLineType(pair[1]),
      number: index + 1
    }
  }
}

function isTest (line) {

  return REGEXES.test.test(line)
    && line.indexOf('# tests') < 0
    && line.indexOf('# pass') < 0
    && line.indexOf('# fail') < 0
    && !isOk(line)
}

function isOk (line) {

  return line === '# ok'
}

function isResult (line) {

  return REGEXES.result.test(line)
}

function isPlan (line) {

  return REGEXES.plan.test(line)
}

function isVersion (line) {

  return REGEXES.version.test(line)
}

function isCommentBlockStart (line) {

  if (line === null || line === undefined) {
    return false
  }

  return line.indexOf('  ---') === 0
}

function isCommentBlockEnd (line) {

  if (line === null || line === undefined) {
    return false
  }

  return line.indexOf('  ...') === 0
}

function isAssertion (line) {

  return REGEXES.assertion.test(line)
}

function getLineType (line) {

  if (isTest(line)) {
    return TEST
  }

  if (isAssertion(line)) {
    return ASSERTION
  }

  if (isPlan(line)) {
    return PLAN
  }

  if (isVersion(line)) {
    return VERSION
  }

  if (isCommentBlockStart(line)) {
    return COMMENT_BLOCK_START
  }

  if (isCommentBlockEnd(line)) {
    return COMMENT_BLOCK_END
  }
}

function formatCommentObject (line) {

  var raw = line.current.raw

  return {
    raw: raw,
    title: raw,
    lineNumber: line.current.number,
    type: 'comment'
  }
}

function formatTestObject (line, lineNumber, testNumber) {

  return {
    raw: line,
    type: 'test',
    title: line.replace('# ', ''),
    lineNumber: lineNumber,
    testNumber: testNumber
  }
}

function formatAssertionObject (line, testNumber) {

  var m = REGEXES.assertion.exec(line.raw)
  var rawDiagnostic = ''

  if (line.rawDiagnostic) {
    rawDiagnostic = line.rawDiagnostic.join('\n')
  }

  return {
    type: 'assertion',
    title: m[3],
    raw: line.raw + '\n' + rawDiagnostic,
    ok: !m[1],
    diagnostic: line.diagnostic, // TODO: rename this to "diagnostic",
    rawDiagnostic: rawDiagnostic,
    lineNumber: line.lineNumber,
    testNumber: testNumber,
    assertionNumber: line.assertionNumber
  }
}

function formatPlanObject (line) {

  var m = REGEXES.plan.exec(line);

  return {
    type: 'plan',
    raw: line,
    from: m[1] && Number(m[1]),
    to: m[2] && Number(m[2]),
    skip: m[3]
  }
}

function formatVersionObject (line) {

  return {
    raw: line,
    type: 'version'
  }
}
