import assert from 'node:assert/strict'
import { createWriteStream, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { runProcessSync, spawnProcess } from './script-child-process.mjs'

const base = process.env.BASE_SHA
assert(/^[a-f0-9]{40}$/.test(base), 'A full baseline SHA is required')
const directory = join(process.env.RUNNER_TEMP, 'screen-clock-comparison')
mkdirSync(directory, { recursive: true })
const paths = [
  'src/main/runtime/agent-transcript-pane-test-harness.ts',
  'src/main/runtime/screen-ruled-agent-transcript-suite.ts',
  'src/main/runtime/codex-header-readiness-transcripts.test.ts',
  'src/main/runtime/codex-quiet-ready-screen.test.ts'
]
const candidate = paths.map((path) => readFileSync(path, 'utf8'))
const baseline = paths.map((path) => {
  const result = runProcessSync({ program: 'git', args: ['show', `${base}:${path}`] })
  assert.equal(result.code, 0, result.stderr)
  return result.stdout
})
const tests = [
  'src/main/runtime/antigravity-screen-readiness-transcripts.test.ts',
  'src/main/runtime/cline-screen-readiness-transcripts.test.ts',
  'src/main/runtime/prime-agent-screen-readiness-transcripts.test.ts',
  'src/main/runtime/codex-header-readiness-transcripts.test.ts',
  'src/main/runtime/codex-quiet-ready-screen.test.ts'
]
const results = []
let originalAssertions

async function measure(variant, sample) {
  paths.forEach((path, index) =>
    writeFileSync(path, variant === 'baseline' ? baseline[index] : candidate[index])
  )
  const report = join(directory, `${sample}-${variant}.json`)
  const log = createWriteStream(join(directory, `${sample}-${variant}.log`))
  const started = performance.now()
  const child = spawnProcess({
    program: 'pnpm',
    args: [
      'exec',
      'vitest',
      'run',
      '--config',
      'config/vitest.config.ts',
      '--maxWorkers=4',
      '--reporter=json',
      `--outputFile=${report}`,
      ...tests
    ],
    env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' }
  })
  child.stdout.pipe(log, { end: false })
  child.stderr.pipe(log, { end: false })
  const code = await new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('close', resolve)
  })
  log.end()
  assert.equal(code, 0, `${variant} failed; inspect its log`)
  const data = JSON.parse(readFileSync(report, 'utf8'))
  assert(data.success && data.numFailedTests === 0)
  const assertions = data.testResults.flatMap((file) => file.assertionResults)
  assert(assertions.every((test) => test.status === 'passed'))
  const names = new Set(assertions.map((test) => test.fullName))
  if (variant === 'baseline') {
    originalAssertions ??= names
    assert.equal(names.size, originalAssertions.size)
    assert([...originalAssertions].every((name) => names.has(name)))
  } else {
    assert(originalAssertions)
    assert([...originalAssertions].every((name) => names.has(name)))
    assert(names.size >= originalAssertions.size)
  }
  const result = {
    variant,
    sample,
    milliseconds: Math.round(performance.now() - started),
    assertions: assertions.length,
    files: data.testResults.map((file) => ({
      name: file.name,
      milliseconds: file.endTime - file.startTime,
      assertions: file.assertionResults.length
    }))
  }
  results.push(result)
  writeFileSync(join(directory, 'results.json'), JSON.stringify(results, null, 2))
  console.log(JSON.stringify(result))
}

try {
  for (let sample = 1; sample <= 3; sample++) {
    for (const variant of sample % 2 ? ['baseline', 'candidate'] : ['candidate', 'baseline']) {
      await measure(variant, sample)
    }
  }
} finally {
  paths.forEach((path, index) => writeFileSync(path, candidate[index]))
}
