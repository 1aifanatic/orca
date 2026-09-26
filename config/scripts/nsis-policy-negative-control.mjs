import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, realpathSync, writeFileSync } from 'node:fs'

const guardedValidator = [
  `      "try { $parameters = @{ ErrorAction = 'Stop' };",`,
  `      'if ($Scope) { $parameters.Scope = $Scope };',`,
  `      "return ((Get-ExecutionPolicy @parameters) -eq 'Restricted')",`,
  `      '} catch { return $false } };',`
].join('\n')
const uncheckedValidator = [
  `      '$parameters = @{};',`,
  `      'if ($Scope) { $parameters.Scope = $Scope };',`,
  `      "if ((Get-ExecutionPolicy @parameters) -ne 'Restricted') { return $false };",`,
  `      'return $true };',`
].join('\n')
const expectedFailures = [
  'SysWOW64 permits the real inline process query',
  'System32 permits the real inline process query',
  'SysWOW64 rejects a failed process query',
  'System32 rejects a failed process query'
]

export function restoreUncheckedValidator(source) {
  assert.equal(source.split(guardedValidator).length, 2, 'Expected exactly one final validator')
  return source.replace(guardedValidator, uncheckedValidator)
}

export function verifyNegativeControl(report, testExitCode) {
  assert.equal(testExitCode, 1, 'Vitest must reject the mutated fixture')
  assert.equal(report.success, false)
  assert.equal(report.numTotalTests, 6)
  assert.equal(report.numPassedTests, 2)
  assert.equal(report.numFailedTests, 4)
  assert.equal(report.numPendingTests, 0)
  assert.equal(report.numTodoTests, 0)
  assert.equal(report.testResults.length, 1)
  const file = report.testResults[0]
  assert.equal(file.message, '', 'Unexpected suite setup failure')
  assert.equal(file.assertionResults.length, 6)
  const failed = file.assertionResults.filter((result) => result.status === 'failed')
  assert.deepEqual(failed.map((result) => result.title).sort(), [...expectedFailures].sort())
  for (const test of failed) {
    assert.equal(test.failureMessages.length, 1, test.title)
    const match = test.failureMessages[0].match(/(\{"code":[^\r\n]+\})/)
    assert.ok(match, `${test.title}: missing child-process evidence`)
    const result = JSON.parse(match[1])
    assert.equal(result.code, 11, test.title)
    assert.equal(result.signal, null, test.title)
    assert.equal(result.timedOut, false, test.title)
    assert.equal(result.outputTruncated, false, test.title)
    assert.match(result.stderr, /Get-ExecutionPolicy/, test.title)
    assert.match(result.stderr, /__orca_invalid_scope__/, test.title)
    assert.doesNotMatch(result.stdout, /orca-nsis: restricted policy verified/, test.title)
    assert.doesNotMatch(result.stdout, /orca-nsis: injected query failure/, test.title)
  }
  return failed.map((result) => ({ test: result.title, code: 11 }))
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(import.meta.filename)) {
  const [, , operation, input, extra] = process.argv
  if (operation === 'prepare') {
    assert.ok(extra, 'An original-source artifact path is required')
    const original = readFileSync(input, 'utf8')
    const mutated = restoreUncheckedValidator(original)
    writeFileSync(extra, original)
    writeFileSync(input, mutated)
    console.log(
      JSON.stringify({
        originalSha256: createHash('sha256').update(original).digest('hex'),
        mutatedSha256: createHash('sha256').update(mutated).digest('hex')
      })
    )
  } else {
    assert.equal(operation, 'verify')
    console.log(
      JSON.stringify(verifyNegativeControl(JSON.parse(readFileSync(input, 'utf8')), Number(extra)))
    )
  }
}
