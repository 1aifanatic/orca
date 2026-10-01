import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { describeProcessFailure, runProcessSync } from './script-child-process.mjs'

assert(process.env.GITHUB_ACTIONS === 'true', 'Use a disposable pilot runner')
assert(process.env.RUNNER_TEMP && isAbsolute(process.env.RUNNER_TEMP), 'Require RUNNER_TEMP')
if (process.env.GITHUB_RUN_ID) {
  assert.equal(process.platform, 'linux', 'Require the unit runner platform')
  assert.equal(process.arch, 'arm64', 'Require the unit runner architecture')
  assert.equal(availableParallelism(), 4, 'Require the unit runner CPU count')
} else {
  assert.equal(process.env.ORCA_POOL_PILOT_FAULTS_ONLY, '1', 'Local runs exercise controls only')
}
const repository = resolve(import.meta.dirname, '../..')
const directory = join(process.env.RUNNER_TEMP, 'unit-pool-comparison')
mkdirSync(directory, { recursive: true })
const cohortPath = join(repository, 'config/scripts/ci-unit-pool-pilot-files.json')
const cohorts = JSON.parse(readFileSync(cohortPath, 'utf8'))
const sourceHazards =
  /process\.(?:chdir|exit|abort|kill|on|once|addListener|prependListener)\(|process\.env\.TZ\s*=|\b(?:globalThis|global)\.gc|(?:from|import|require)[^\n]*(?:node-pty|better-sqlite3|child_process|['"]electron['"])/
const filenameHazards =
  /(?:node-pty|retention|lifecycle|lifetime|teardown|crash|signal|cleanup|process-cadence)/i
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
const writeJson = (name, value) =>
  writeFileSync(join(directory, name), `${JSON.stringify(value, null, 2)}\n`)
const inputFiles = [
  'package.json',
  'pnpm-lock.yaml',
  'config/vitest.config.ts',
  ...Object.values(cohorts).flat()
]
const inputManifest = () =>
  inputFiles.map((file) => ({ file, sha256: digest(readFileSync(join(repository, file))) }))
const originalManifest = inputManifest()
const sourceScans = []
for (const [cohort, files] of Object.entries(cohorts)) {
  assert(files.length > 0 && new Set(files).size === files.length, 'Require unique nonempty cohort')
  for (const file of files) {
    assert(
      !file.includes('..') && !isAbsolute(file) && /\.test\.tsx?$/.test(file),
      `Unexpected pilot file: ${file}`
    )
    assert(
      cohort === 'renderer-happy-dom'
        ? file.startsWith('src/renderer/')
        : file.startsWith('src/shared/'),
      `Unexpected cohort: ${file}`
    )
    const source = readFileSync(join(repository, file), 'utf8')
    const hazards = source.match(sourceHazards)
    sourceScans.push({ file, sha256: digest(source), hazards: hazards?.[0] ?? null })
    assert(!filenameHazards.test(file) && !hazards, `Unreviewed process/native input: ${file}`)
    if (cohort === 'renderer-happy-dom') {
      assert(source.includes('@vitest-environment happy-dom'), `Environment changed: ${file}`)
    }
  }
}
writeJson('source-scans.json', {
  sourceHazards: sourceHazards.source,
  filenameHazards: filenameHazards.source,
  files: sourceScans
})
writeJson('environment.json', {
  node: process.version,
  executable: process.execPath,
  platform: process.platform,
  architecture: process.arch,
  cpus: availableParallelism(),
  image: process.env.ImageOS,
  imageVersion: process.env.ImageVersion,
  commit: process.env.GITHUB_SHA,
  workers: 4,
  isolate: true,
  fsModuleCache: false,
  nodeCompileCache: false,
  parentFlags: ['--expose-gc'],
  forkFlags: ['--no-experimental-webstorage', '--expose-gc'],
  threadFlags: ['--no-experimental-webstorage'],
  originalManifest,
  cohorts
})

const vitest = join(repository, 'node_modules/vitest/dist/index.js')
const setup = join(directory, 'pool-scope-setup.mjs')
writeFileSync(
  setup,
  `import { beforeAll } from ${JSON.stringify(vitest)}
beforeAll(() => { if (typeof globalThis.gc !== 'function') throw new Error('Pilot GC unavailable') })
process.dlopen = () => { throw new Error('Pilot guard: native addon') }
process.chdir = () => { throw new Error('Pilot guard: chdir') }
process.kill = () => { throw new Error('Pilot guard: process signal') }
`
)
const isolationFiles = ['a', 'b'].map((name) => {
  const file = join(directory, `isolation-${name}.test.mjs`)
  writeFileSync(
    file,
    `import { expect, it } from ${JSON.stringify(vitest)}
it('keeps globals and env isolated', () => {
  expect(globalThis.orcaPoolPilotIsolation).toBeUndefined()
  expect(process.env.ORCA_POOL_PILOT_ISOLATION).toBeUndefined()
  globalThis.orcaPoolPilotIsolation = ${JSON.stringify(name)}
  process.env.ORCA_POOL_PILOT_ISOLATION = ${JSON.stringify(name)}
})
`
  )
  return file
})
const faultFiles = ['native addon', 'chdir', 'process signal'].map((name, index) => {
  const file = join(directory, `fault-${index}.test.mjs`)
  const trigger = [
    'process.dlopen({})',
    'process.chdir(process.cwd())',
    'process.kill(process.pid, 0)'
  ][index]
  writeFileSync(
    file,
    `import { it } from ${JSON.stringify(vitest)}\nit(${JSON.stringify(name)}, () => { ${trigger} })\n`
  )
  return file
})
const config = join(directory, 'vitest.config.mjs')
writeFileSync(
  config,
  `import base from ${JSON.stringify(join(repository, 'config/vitest.config.ts'))}
import { writeFileSync } from 'node:fs'
const modules = new Set()
export default {
  ...base,
  plugins: [{ name: 'orca-pool-pilot-module-audit', transform(code, id) { modules.add(id); return null }, closeBundle() { writeFileSync(process.env.ORCA_POOL_PILOT_MODULES, JSON.stringify([...modules].sort())+'\\n') } }],
  test: {
    ...base.test, include: [...base.test.include, ${JSON.stringify(join(directory, '*.test.mjs'))}],
    pool: process.env.ORCA_POOL_PILOT_POOL, maxWorkers: Number(process.env.ORCA_POOL_PILOT_WORKERS), isolate: process.env.ORCA_POOL_PILOT_ISOLATE !== 'false',
    experimental: { fsModuleCache: false },
    execArgv: process.env.ORCA_POOL_PILOT_NO_GC === '1' || process.env.ORCA_POOL_PILOT_POOL === 'threads' ? base.test.execArgv.filter(arg => arg !== '--expose-gc') : base.test.execArgv,
    setupFiles: [...base.test.setupFiles, ${JSON.stringify(setup)}], reporters: ['json']
  }
}
`
)
const rows = []
function execute(label, pool, files, options = {}) {
  const reportPath = join(directory, `${label}.json`)
  const modulePath = join(directory, `${label}-modules.json`)
  const started = performance.now()
  const result = runProcessSync({
    program: process.execPath,
    args: [
      ...(options.noGc ? [] : ['--expose-gc']),
      join(repository, 'node_modules/vitest/vitest.mjs'),
      'run',
      '--config',
      config,
      `--outputFile=${reportPath}`,
      ...files
    ],
    cwd: repository,
    timeoutMs: 5 * 60_000,
    maxOutputBytes: 32 * 1024 * 1024,
    env: {
      ...process.env,
      ORCA_BACKGROUND_LAUNCH: '1',
      ORCA_BALANCE_UNIT_SHARDS: '0',
      NODE_DISABLE_COMPILE_CACHE: '1',
      ORCA_POOL_PILOT_POOL: pool,
      ORCA_POOL_PILOT_MODULES: modulePath,
      ORCA_POOL_PILOT_NO_GC: options.noGc ? '1' : '0',
      ORCA_POOL_PILOT_WORKERS: options.singleWorker || options.noIsolate ? '1' : '4',
      ORCA_POOL_PILOT_ISOLATE: options.noIsolate ? 'false' : 'true'
    }
  })
  const elapsedMs = performance.now() - started
  writeFileSync(join(directory, `${label}.log`), result.stdout + result.stderr)
  assert(!result.timedOut && !result.outputTruncated, describeProcessFailure(result))
  const report = JSON.parse(readFileSync(reportPath, 'utf8'))
  const modules = JSON.parse(readFileSync(modulePath, 'utf8'))
  const assertions = report.testResults
    .flatMap((file) =>
      file.assertionResults.map((test) => ({
        file: file.name,
        name: test.fullName,
        status: test.status
      }))
    )
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
  const row = {
    label,
    pool,
    elapsedMs,
    code: result.code,
    success: report.success,
    files: report.testResults.length,
    tests: report.numTotalTests,
    passed: report.numPassedTests,
    failed: report.numFailedTests,
    skipped: report.numPendingTests,
    moduleCount: modules.length,
    moduleSha256: digest(JSON.stringify(modules)),
    assertions
  }
  rows.push(row)
  writeJson('results.json', rows)
  assert.equal(report.testResults.length, files.length, `${label}: preserve file count`)
  assert(
    !modules.some((id) => id.includes('/src/main/') || /\.node(?:\?|$)/.test(id)),
    `${label}: unexpected main/native module`
  )
  if (options.failure) {
    assert(result.code !== 0 && !report.success, `${label}: negative control falsely passed`)
    const failures = report.testResults.map((file) =>
      JSON.stringify(file).includes(options.failure)
    )
    assert(
      options.partialFailure ? failures.some(Boolean) : failures.every(Boolean),
      `${label}: wrong negative failure`
    )
  } else {
    assert.equal(result.code, 0, describeProcessFailure(result))
    assert(
      report.success && row.failed === 0 && row.skipped === 0,
      `${label}: require complete passing scope`
    )
  }
  console.log(JSON.stringify({ ...row, assertions: undefined }))
  return row
}
for (const pool of ['forks', 'threads']) {
  execute(`isolation-positive-${pool}`, pool, isolationFiles, { singleWorker: true })
  execute(`guards-${pool}`, pool, faultFiles, { failure: 'Pilot guard:' })
  execute(`gc-negative-${pool}`, pool, [isolationFiles[0]], {
    noGc: true,
    failure: 'Pilot GC unavailable'
  })
  execute(`isolation-negative-${pool}`, pool, isolationFiles, {
    noIsolate: true,
    failure: 'to be undefined',
    partialFailure: true
  })
}
if (process.env.ORCA_POOL_PILOT_FAULTS_ONLY !== '1') {
  const summaries = []
  for (const [cohort, files] of Object.entries(cohorts)) {
    const selected = [...files, ...isolationFiles]
    const samples = []
    let baseline
    for (let pair = 1; pair <= 3; pair++) {
      for (const pool of pair % 2 ? ['forks', 'threads'] : ['threads', 'forks']) {
        const row = execute(`${cohort}-${pair}-${pool}`, pool, selected)
        baseline ??= row
        assert.deepEqual(row.assertions, baseline.assertions, `${cohort}: preserve every assertion`)
        assert.equal(row.moduleCount, baseline.moduleCount, `${cohort}: preserve module count`)
        assert.equal(row.moduleSha256, baseline.moduleSha256, `${cohort}: preserve module graph`)
        assert.equal(
          row.tests,
          { 'renderer-happy-dom': 570, 'shared-pure-js': 248 }[cohort] + 2,
          `${cohort}: preserve audited assertion count`
        )
        samples.push(row)
      }
    }
    const median = (pool) =>
      samples
        .filter((row) => row.pool === pool)
        .map((row) => row.elapsedMs)
        .sort((left, right) => left - right)[1]
    summaries.push({
      cohort,
      forksMedianMs: median('forks'),
      threadsMedianMs: median('threads'),
      candidateToBaselineRatio: median('threads') / median('forks'),
      files: baseline.files,
      tests: baseline.tests
    })
  }
  writeJson('summary.json', summaries)
}
assert.deepEqual(inputManifest(), originalManifest, 'Preserve every original source input')
