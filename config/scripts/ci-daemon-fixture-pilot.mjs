import assert from 'node:assert/strict'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { join, resolve } from 'node:path'
import { describeProcessFailure, runProcessSync } from './script-child-process.mjs'

assert(process.platform === 'linux' && process.arch === 'x64', 'Use a Linux x64 pilot runner')
assert(
  process.env.GITHUB_ACTIONS === 'true',
  'Reset Docker caches only on a disposable hosted pilot'
)
const [phase, ...args] = process.argv.slice(2)
assert(
  ['reset', 'start', 'measure', 'docker'].includes(phase),
  'Expected reset, start, measure or docker'
)
const repository = resolve(import.meta.dirname, '../..')
assert.equal(repository, resolve(process.env.GITHUB_WORKSPACE), 'Use the pilot checkout')
const directory = join(process.env.RUNNER_TEMP, 'daemon-fixture-comparison')
mkdirSync(directory, { recursive: true })
const fixture = 'daemon-shutdown-descendants'
const image = `orca-package-fixture-${fixture}:cache`
const base = 'node:22-bookworm-slim'
assert(
  readFileSync(join(repository, 'config/docker', fixture, 'Dockerfile'), 'utf8').startsWith(
    `FROM ${base}\n`
  )
)

function execute(program, argv, env = {}) {
  return runProcessSync({
    program,
    args: argv,
    cwd: repository,
    env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1', ...env },
    timeoutMs: 10 * 60_000,
    maxOutputBytes: 16 * 1024 * 1024
  })
}

function requireSuccess(result) {
  assert.equal(result.code, 0, describeProcessFailure(result))
  assert(!result.timedOut && !result.outputTruncated, 'Require complete command output')
  return result
}

if (phase === 'docker') {
  const started = performance.now()
  const result = execute('docker', args)
  appendFileSync(
    process.env.ORCA_PILOT_DOCKER_TRACE,
    `${JSON.stringify({
      args,
      milliseconds: Math.round(performance.now() - started),
      code: result.code,
      stdout: result.stdout,
      stderr: result.stderr
    })}\n`
  )
  process.stdout.write(result.stdout)
  process.stderr.write(result.stderr)
  process.exit(result.code ?? 1)
}

assert.equal(args.length, 0)
const sample = Number(process.env.FIXTURE_SAMPLE)
const treatment = process.env.FIXTURE_TREATMENT
assert([1, 2, 3].includes(sample), 'Require one of three samples')
assert(['cold', 'warm'].includes(treatment), 'Require cold or warm treatment')

if (phase === 'reset') {
  // Every treatment owns a fresh BuildKit cache and base-image pull.
  requireSuccess(execute('docker', ['builder', 'prune', '--all', '--force']))
  for (const tag of [image, base]) {
    if (execute('docker', ['image', 'inspect', tag]).code === 0) {
      requireSuccess(execute('docker', ['image', 'rm', '--force', tag]))
    }
  }
} else if (phase === 'start') {
  assert(process.env.GITHUB_OUTPUT, 'Require workflow step outputs')
  appendFileSync(process.env.GITHUB_OUTPUT, `started=${Date.now()}\n`)
} else {
  const started = Number(process.env.FIXTURE_STARTED)
  assert(started > 0 && started <= Date.now(), 'Require a timestamp before restore/oracle')
  const cached = process.env.ORCA_DAEMON_SHUTDOWN_FIXTURE_CACHE_IMAGE ?? ''
  if (treatment === 'warm') {
    assert.equal(cached, image, 'Require the existing action to restore a real fixture archive')
    requireSuccess(execute('docker', ['image', 'inspect', image]))
  } else {
    assert.equal(cached, '', 'Cold treatment must not import a cached fixture')
  }
  const prefix = join(directory, `${sample}-${treatment}`)
  const tracePath = `${prefix}-docker.jsonl`
  writeFileSync(tracePath, '')
  const wrapper = join(directory, 'record-docker')
  writeFileSync(
    wrapper,
    '#!/usr/bin/env bash\nset -euo pipefail\nexec "$ORCA_PILOT_NODE" "$ORCA_PILOT_DRIVER" docker "$@"\n',
    { mode: 0o755 }
  )
  const oracleStarted = performance.now()
  const result = execute(
    process.execPath,
    ['config/scripts/run-daemon-shutdown-descendants-docker.mjs'],
    {
      DOCKER_BUILDKIT: '1',
      ORCA_DOCKER: wrapper,
      ORCA_PILOT_NODE: process.execPath,
      ORCA_PILOT_DRIVER: import.meta.filename,
      ORCA_PILOT_DOCKER_TRACE: tracePath
    }
  )
  const oracleMs = Math.round(performance.now() - oracleStarted)
  const totalMs = Date.now() - started
  writeFileSync(`${prefix}-oracle.log`, result.stdout + result.stderr)
  requireSuccess(result)
  const assertions = result.stdout
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map(JSON.parse)
  assert.equal(assertions.length, 1, 'Run the same candidate-only oracle as normal package CI')
  assert.equal(assertions[0].mode, 'candidate')
  assert.equal(assertions[0].childAfterDaemonExit, 'gone')
  assert.equal(assertions[0].canaryAfterDaemonExit, 'live')
  const commands = readFileSync(tracePath, 'utf8').trim().split('\n').map(JSON.parse)
  const builds = commands.filter((command) => command.args[0] === 'build')
  const runs = commands.filter((command) => command.args[0] === 'run')
  assert.equal(builds.length, 1)
  assert.equal(runs.length, 1)
  const build = builds[0]
  assert.equal(build.code, 0)
  const cacheIndex = build.args.indexOf('--cache-from')
  if (treatment === 'warm') {
    assert.equal(build.args[cacheIndex + 1], image)
  } else {
    assert.equal(cacheIndex, -1)
  }
  const buildLog = build.stdout + build.stderr
  const provisioning = buildLog.match(/^#(\d+) \[[^\]]+\] RUN apt-get update/m)
  assert(provisioning, 'Require the real apt/node-pty provisioning step in BuildKit output')
  const provisioningCached = new RegExp(`^#${provisioning[1]} CACHED$`, 'm').test(buildLog)
  assert.equal(provisioningCached, treatment === 'warm', 'Verify the actual Docker cache treatment')
  const resolvedBase = buildLog.match(
    /\bFROM (?:docker\.io\/library\/)?node:22-bookworm-slim@(sha256:[a-f0-9]{64})/
  )
  assert(resolvedBase, 'Require the immutable base digest actually used by BuildKit')
  const baseImageDigest = resolvedBase[1]
  const archive = join(process.env.RUNNER_TEMP, 'orca-package-fixtures', `${fixture}.tar`)
  const row = {
    sample,
    treatment,
    node: process.version,
    oracleMs,
    preparationMs: totalMs - oracleMs,
    totalMs,
    dockerBuildMs: build.milliseconds,
    dockerRunMs: runs[0].milliseconds,
    provisioningCached,
    baseImageDigest,
    archiveBytes: treatment === 'warm' ? statSync(archive).size : null,
    oracleAssertions: assertions
  }
  const resultPath = join(directory, 'results.json')
  const previous = existsSync(resultPath) ? JSON.parse(readFileSync(resultPath, 'utf8')) : []
  assert(
    previous.every((result) => result.baseImageDigest === baseImageDigest),
    'Base image changed across treatments'
  )
  writeFileSync(resultPath, JSON.stringify([...previous, row], null, 2))
  console.log(JSON.stringify(row))
}
