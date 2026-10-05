import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
const root = process.env.GITHUB_WORKSPACE
const home = process.env.ORCA_TYPECHECK_PILOT_HOME
const reports = join(home, 'reports')
const command = process.argv[2]
const label = process.argv[3]
const read = (path) => JSON.parse(readFileSync(path, 'utf8'))
const hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')
const ts = createRequire(join(root, 'mobile/package.json'))('typescript')
const guardRows = (directory) =>
  readdirSync(directory)
    .filter((name) => /^\d+\.json$/.test(name))
    .map((name) => read(join(directory, name)))
function validateHealthy(row) {
  assert.equal(row.productionOutcome, 'success')
  assert.equal(row.ratchetOutcome, 'success')
  assert.equal(row.testStarted, true)
  assert(row.memory?.peakSampledRssKiB > 0, 'Require a real sampled memory peak')
  assert.equal(row.workers.length, 3)
  for (const worker of row.workers) {
    assert.equal(worker.phase, 'exit')
    assert.deepEqual(worker.nativeAttempts, [])
    assert.deepEqual(worker.mutations, [])
  }
}
if (command === 'init') {
  mkdirSync(reports, { recursive: true })
  const expectedSha = (process.env.SOURCE_REF ?? '').toLowerCase()
  assert(/^[0-9a-f]{40}$/.test(expectedSha), 'Pin an exact source SHA')
  const { runProcessSync } = await import(
    pathToFileURL(join(root, 'config/scripts/script-child-process.mjs'))
  )
  const actual = runProcessSync({
    program: 'git',
    args: ['rev-parse', 'HEAD'],
    cwd: root,
    timeoutMs: 30_000
  })
  assert.equal(actual.code, 0)
  assert.equal(
    actual.stdout.trim(),
    expectedSha,
    'Actual source checkout HEAD must equal SOURCE_REF'
  )
  const configs = {}
  for (const [name, project] of [
    ['production', 'tsconfig.json'],
    ['tests', 'tsconfig.test.json']
  ]) {
    const config = ts.getParsedCommandLineOfConfigFile(
      join(root, 'mobile', project),
      {},
      {
        ...ts.sys,
        onUnRecoverableConfigFileDiagnostic: (error) => {
          throw new Error(ts.flattenDiagnosticMessageText(error.messageText, '\n'))
        }
      }
    )
    assert.equal(config.options.noEmit, true)
    assert(
      !config.options.incremental && !config.options.composite && !config.options.tsBuildInfoFile
    )
    assert.equal(config.errors.length, 0)
    configs[name] = {
      noEmit: true,
      incremental: false,
      composite: false,
      fileCount: config.fileNames.length
    }
  }
  writeFileSync(
    join(home, 'source.json'),
    JSON.stringify(
      {
        sourceSha: process.env.SOURCE_REF.toLowerCase(),
        configs,
        node: process.version,
        typeScript: ts.version,
        toolHashes: Object.fromEntries(
          [
            'mobile/scripts/check-tests-typecheck-ratchet.mjs',
            'mobile/tsconfig.json',
            'mobile/tsconfig.test.json',
            'mobile/tests-typecheck-baseline.txt'
          ].map((file) => [file, hash(join(root, file))])
        ),
        guardSha256: hash(join(home, 'guard.cjs'))
      },
      null,
      2
    )
  )
  if (process.env.SCENARIO === 'production') {
    writeFileSync(
      join(root, 'mobile/src/ci-production-types-failure.ts'),
      'export const ciProductionTypeFault: string = 42\n'
    )
    const file = join(root, 'mobile/tsconfig.test.json')
    const config = ts.parseConfigFileTextToJson(file, readFileSync(file, 'utf8')).config
    config.exclude.push('src/ci-production-types-failure.ts')
    writeFileSync(file, JSON.stringify(config))
  } else if (process.env.SCENARIO === 'ratchet') {
    writeFileSync(
      join(root, 'mobile/src/ci-test-types-failure.test.ts'),
      'export const ciTestTypeFault: string = 42\n'
    )
  }
} else if (command === 'start') {
  const directory = join(reports, label)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'start.json'), JSON.stringify({ label, startedUnixMs: Date.now() }))
} else if (command === 'seal') {
  const directory = join(reports, label)
  const start = read(join(directory, 'start.json'))
  const finishedUnixMs = Date.now()
  const memory = existsSync(join(directory, 'memory.json'))
    ? read(join(directory, 'memory.json'))
    : null
  const row = {
    ...start,
    finishedUnixMs,
    elapsedBracketMs: finishedUnixMs - start.startedUnixMs,
    productionOutcome: process.env.PRODUCTION_OUTCOME,
    ratchetOutcome: process.env.RATCHET_OUTCOME,
    cancelled: process.env.CANCELLED === 'true',
    testStarted: existsSync(join(directory, 'Test-started.txt')),
    workers: guardRows(directory),
    memory,
    timingScope:
      'Complete typecheck stage wall bracket including observer, native background/wait and step-boundary overhead; excludes dependency installation and later Test suite.'
  }
  writeFileSync(join(directory, 'sealed.json'), JSON.stringify(row, null, 2))
  if (['production', 'ratchet'].includes(process.env.SCENARIO)) {
    assert.equal(row.workers.length, 3)
    for (const worker of row.workers) {
      assert.equal(worker.phase, 'exit')
      assert.deepEqual(worker.nativeAttempts, [])
      assert.deepEqual(worker.mutations, [])
    }
  }
  if (process.env.SCENARIO === 'production') {
    assert.equal(row.productionOutcome, 'failure')
    assert.equal(row.ratchetOutcome, 'success')
    assert(!row.testStarted)
  } else if (process.env.SCENARIO === 'ratchet') {
    assert.equal(row.productionOutcome, 'success')
    assert.equal(row.ratchetOutcome, 'failure')
    assert(!row.testStarted)
  } else if (process.env.SCENARIO === 'cancel') {
    assert(row.workers.length >= 2, 'Cancel after actual typecheck tools begin')
    assert(row.cancelled && !row.testStarted, 'External workflow cancellation must block Test')
  } else {
    validateHealthy(row)
  }
  writeFileSync(
    join(directory, 'control-passed.json'),
    JSON.stringify({ passed: true, scenario: process.env.SCENARIO ?? 'healthy', label })
  )
  console.log(
    JSON.stringify({
      label,
      elapsedBracketMs: row.elapsedBracketMs,
      peakSampledRssKiB: memory?.peakSampledRssKiB,
      productionOutcome: row.productionOutcome,
      ratchetOutcome: row.ratchetOutcome,
      cancelled: row.cancelled,
      testStarted: row.testStarted
    })
  )
} else if (command === 'finish') {
  writeFileSync(join(home, 'monitor.done'), '')
  if (process.env.SCENARIO && process.env.SCENARIO !== 'healthy') {
    assert(
      existsSync(join(reports, 'control', 'control-passed.json')),
      'Native control did not produce a passing receipt'
    )
  } else {
    const rows = [
      'pair-1-serial',
      'pair-1-overlap',
      'pair-2-overlap',
      'pair-2-serial',
      'pair-3-serial',
      'pair-3-overlap'
    ].map((label) => read(join(reports, label, 'sealed.json')))
    rows.forEach(validateHealthy)
    const signatures = (row) =>
      row.workers
        .map((worker) => ({
          role: worker.argv[1].includes('check-tests-typecheck')
            ? 'ratchet'
            : worker.argv[1].includes('/bin/tsc')
              ? 'production'
              : 'test-compiler',
          code: worker.code,
          stdoutSha256: worker.stdoutSha256,
          stderrSha256: worker.stderrSha256
        }))
        .sort((a, b) => a.role.localeCompare(b.role))
    rows
      .slice(1)
      .forEach((row) =>
        assert.deepEqual(
          signatures(row),
          signatures(rows[0]),
          'Complete stages must have identical output hashes and compiler/ratchet verdicts'
        )
      )
    const median = (values) => {
      const sorted = [...values].sort((a, b) => a - b)
      const middle = Math.floor(sorted.length / 2)
      return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
    }
    const pairs = [1, 2, 3].map((pair) => {
      const serial = rows.find((row) => row.label === `pair-${pair}-serial`)
      const overlap = rows.find((row) => row.label === `pair-${pair}-overlap`)
      return {
        pair,
        serialMs: serial.elapsedBracketMs,
        overlapMs: overlap.elapsedBracketMs,
        savedMs: serial.elapsedBracketMs - overlap.elapsedBracketMs,
        serialPeakSampledRssKiB: serial.memory?.peakSampledRssKiB,
        overlapPeakSampledRssKiB: overlap.memory?.peakSampledRssKiB
      }
    })
    writeFileSync(
      join(home, 'qualification.json'),
      JSON.stringify(
        {
          source: read(join(home, 'source.json')),
          pairs,
          medianPairedSavedMs: median(pairs.map((row) => row.savedMs)),
          medianSerialMs: median(pairs.map((row) => row.serialMs)),
          medianOverlapMs: median(pairs.map((row) => row.overlapMs)),
          limits: [
            'Typecheck stages only; no complete workflow/PR latency or runner-hour saving claim.',
            'Memory is owned-process aggregate RSS sampled every200ms, not a kernel maximum.',
            'Three pairs alternate order; first-arm order is not perfectly balanced with an odd pair count.',
            'Independent failure and external cancellation controls have separate native Actions receipts.'
          ]
        },
        null,
        2
      )
    )
  }
} else {
  throw new Error(`Unknown qualification command: ${command}`)
}
