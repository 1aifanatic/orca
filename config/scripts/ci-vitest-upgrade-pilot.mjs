import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = process.cwd()
const shard = Number(process.env.SHARD)
assert([2, 4].includes(shard), 'Pilot only runs the two selected complete shards')
assert(process.platform === 'linux', 'Hosted pilot expects a Linux runner')
const tools = join(process.env.RUNNER_TEMP, 'vitest-upgrade-toolchain')
const evidence = resolve('ci-shards', `vitest-upgrade-${shard}`)
mkdirSync(tools, { recursive: true })
mkdirSync(evidence, { recursive: true })
const originalVitest = realpathSync('node_modules/vitest')
const originalVite = realpathSync('node_modules/vite')
const originalHappyDom = realpathSync('node_modules/happy-dom')
const sourceSha = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' })
assert.equal(sourceSha.status, 0, sourceSha.stderr)
const json = (path) => JSON.parse(readFileSync(path, 'utf8'))
const env = { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' }
delete env.NODE_COMPILE_CACHE
delete env.NODE_DISABLE_COMPILE_CACHE
env.ORCA_SHARD_SOURCE_SHA = sourceSha.stdout.trim()

writeFileSync(join(tools, 'package.json'), JSON.stringify({ private: true }))
const install = spawnSync(
  'npm',
  [
    'install',
    '--prefix',
    tools,
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--legacy-peer-deps',
    '--save-exact',
    'vitest@5.0.2'
  ],
  { env, stdio: 'inherit' }
)
assert.equal(install.status, 0, 'Isolated Vitest installation failed')
// Keep Vite's complete dependency graph and the DOM implementation identical.
for (const [name, target] of [
  ['vite', originalVite],
  ['happy-dom', originalHappyDom]
]) {
  const link = join(tools, 'node_modules', name)
  assert(!existsSync(link), `${name} unexpectedly installed as a transitive dependency`)
  symlinkSync(target, link, 'dir')
}
const candidateVitest = realpathSync(join(tools, 'node_modules/vitest'))
const candidateRequire = createRequire(join(candidateVitest, 'package.json'))
assert.equal(
  realpathSync(candidateRequire.resolve('vite/package.json')),
  join(originalVite, 'package.json')
)
assert.equal(
  realpathSync(candidateRequire.resolve('happy-dom/package.json')),
  join(originalHappyDom, 'package.json')
)
assert.equal(json(join(candidateVitest, 'package.json')).version, '5.0.2')
writeFileSync(
  join(evidence, 'toolchain.json'),
  JSON.stringify(
    {
      sourceSha: env.ORCA_SHARD_SOURCE_SHA,
      node: process.version,
      baseline: json(join(originalVitest, 'package.json')).version,
      candidate: '5.0.2',
      vite: json(join(originalVite, 'package.json')),
      happyDom: json(join(originalHappyDom, 'package.json')).version
    },
    null,
    2
  )
)

const link = resolve('node_modules/vitest')
const savedLink = resolve('node_modules/.vitest-upgrade-original')
const cache = resolve('node_modules/.vite')
const savedCache = resolve('node_modules/.vitest-upgrade-cache-original')
assert(lstatSync(link).isSymbolicLink(), 'Expected pnpm Vitest symlink')
assert(!existsSync(savedLink) && !existsSync(savedCache), 'Pilot backup already exists')
const pilotConfig = join(tools, 'vitest-pilot.config.mjs')
writeFileSync(
  pilotConfig,
  `import config from ${JSON.stringify(pathToFileURL(resolve('config/vitest.config.ts')).href)};\nexport default {...config, test: {...config.test, clearMocks: false}};\n`
)
const measurements = []
const hadCache = existsSync(cache)
renameSync(link, savedLink)
try {
  if (hadCache) {
    renameSync(cache, savedCache)
  }
  for (const mode of shard === 2 ? ['baseline', 'candidate'] : ['candidate', 'baseline']) {
    rmSync(link, { force: true })
    rmSync(cache, { force: true, recursive: true })
    const target = mode === 'baseline' ? originalVitest : candidateVitest
    symlinkSync(target, link, 'dir')
    const resultPath = join(evidence, `${mode}-results.json`)
    const timingPath = join(evidence, `${mode}-timings.json`)
    const log = openSync(join(evidence, `${mode}.log`), 'w')
    console.log(`Starting ${mode} full shard ${shard}/8`)
    const start = performance.now()
    let result
    try {
      result = spawnSync(
        process.execPath,
        [
          join(link, 'vitest.mjs'),
          'run',
          '--config',
          pilotConfig,
          `--shard=${shard}/8`,
          '--reporter=default',
          `--reporter=${resolve('config/scripts/ci-unit-timing-reporter.mjs')}`,
          '--reporter=json',
          `--outputFile=${resultPath}`
        ],
        {
          env: {
            ...env,
            ORCA_UNIT_TIMING_REPORT: timingPath,
            ORCA_SHARD_MANIFEST: join(evidence, `${mode}-assignment.json`)
          },
          stdio: ['ignore', log, log],
          cwd: root,
          timeout: 12 * 60 * 1000
        }
      )
    } finally {
      closeSync(log)
    }
    const measurement = {
      mode,
      shard,
      seconds: (performance.now() - start) / 1000,
      exit: result.status,
      signal: result.signal
    }
    measurements.push(measurement)
    writeFileSync(join(evidence, 'measurements.json'), JSON.stringify(measurements, null, 2))
    console.log(`VITEST_MEASUREMENT ${JSON.stringify(measurement)}`)
  }
} finally {
  rmSync(link, { force: true })
  renameSync(savedLink, link)
  if (!hadCache || existsSync(savedCache)) {
    rmSync(cache, { force: true, recursive: true })
  }
  if (existsSync(savedCache)) {
    renameSync(savedCache, cache)
  }
}

assert.deepEqual(
  json(join(evidence, 'candidate-assignment.json')),
  json(join(evidence, 'baseline-assignment.json')),
  'Complete shard discovery or assignment differs'
)
const baseline = json(join(evidence, 'baseline-timings.json'))
const candidate = json(join(evidence, 'candidate-timings.json'))
assert.deepEqual(candidate.results, baseline.results, 'Per-file verdicts differ')
assert.equal(candidate.unhandledErrors, 0)
assert.equal(baseline.unhandledErrors, 0)
const baselineResults = json(join(evidence, 'baseline-results.json'))
const candidateResults = json(join(evidence, 'candidate-results.json'))
for (const key of [
  'numTotalTests',
  'numPassedTests',
  'numFailedTests',
  'numPendingTests',
  'numTodoTests'
]) {
  assert.equal(candidateResults[key], baselineResults[key], `Test count differs: ${key}`)
}
assert(
  measurements.every(({ exit }) => exit === 0),
  'At least one complete shard failed'
)
console.log('Matched file verdicts and test counts; both complete shards passed')
