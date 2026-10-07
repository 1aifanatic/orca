// Adapted from the reviewed ARM4 materializer; launches no tests.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

assert.equal(process.env.GITHUB_ACTIONS, 'true')
for (const key of ['ORCA_BALANCE_UNIT_SHARDS', 'ORCA_VITEST_RUNTIME', 'NODE_COMPILE_CACHE', 'NODE_DISABLE_COMPILE_CACHE', 'NODE_OPTIONS']) {
  assert.equal(process.env[key], undefined, `Unexpected launch environment: ${key}`)
}
const payload = resolve(import.meta.dirname, 'payload')
const plan = JSON.parse(readFileSync(resolve(payload, 'launch-plan.json'), 'utf8'))
assert.equal(process.env.HTTP_SOURCE_SHA, plan.sourceHead)
const hash = value => createHash('sha256').update(value).digest('hex')
const { runProcessSync } = await import(pathToFileURL(resolve('config/scripts/script-child-process.mjs')).href)
const command = (program, args) => {
  const result = runProcessSync({ program, args, timeoutMs: 10000, maxOutputBytes: 65536 })
  assert.equal(result.code, 0)
  assert.equal(result.outputTruncated, false)
  return result.stdout.trim()
}
assert.equal(command('git', ['rev-parse', 'HEAD']), plan.sourceHead)
assert.equal(command('git', ['diff', '--name-only', 'HEAD']), '')
assert.equal(process.versions.node, '24.21.0')
assert.equal(command('bun', ['--version']), readFileSync('config/.bun-version', 'utf8').trim())
for (const [name, expected] of Object.entries(plan.payloadSha256)) {
  assert.equal(hash(readFileSync(resolve(payload, name))), expected, `Payload changed: ${name}`)
}
for (const [file, expected] of Object.entries(plan.sourceHashes)) {
  if (!file.startsWith('notes/')) assert.equal(hash(readFileSync(file)), expected, `Named source changed: ${file}`)
}
const { NODE_RUNTIME_INCLUDE } = await import(pathToFileURL(resolve('config/scripts/vitest-node-runtime-files.mjs')).href)
assert.deepEqual(NODE_RUNTIME_INCLUDE, plan.nodeRuntimeIncludes)
const directory = plan.isolatedDirectory
mkdirSync(directory, { recursive: true })
mkdirSync('notes/bun-migration/performance', { recursive: true })
copyFileSync(resolve(payload, 'qualify-fixture-reuse.py'), 'notes/bun-migration/performance/qualify-fixture-reuse.py')
copyFileSync(resolve(payload, 'persistence-import-reuse-benchmark-reporter.mjs'), 'notes/bun-migration/performance/persistence-import-reuse-benchmark-reporter.mjs')
copyFileSync(resolve(payload, 'candidate.patch'), `${directory}/candidate.patch`)
copyFileSync(resolve(payload, 'original-source-proposal-proof.json'), `${directory}/original-source-proposal-proof.json`)
copyFileSync(resolve(payload, 'launch-plan.json'), `${directory}/launch-plan.json`)
for (const [file, expected] of Object.entries(plan.sourceHashes)) assert.equal(hash(readFileSync(file)), expected)
const context = {
  sourceSha: plan.sourceHead, definitionSha: process.env.GITHUB_SHA,
  runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT,
  runtime: process.env.HTTP_RUNTIME, seed: Number(process.env.HTTP_SEED),
  platform: process.platform, arch: process.arch, nodeVersion: process.versions.node,
  bunVersion: command('bun', ['--version']), bunRevision: command('bun', ['--revision']),
  nodeExecutable: process.execPath,
  launchEnvironment: Object.fromEntries(['ORCA_BACKGROUND_LAUNCH', 'ORCA_BALANCE_UNIT_SHARDS', 'ORCA_VITEST_RUNTIME', 'NODE_COMPILE_CACHE', 'NODE_DISABLE_COMPILE_CACHE', 'NODE_OPTIONS'].map(key => [key, process.env[key] ?? null])),
  vitestVersion: JSON.parse(readFileSync('node_modules/vitest/package.json', 'utf8')).version,
  controllerSha256: plan.sourceHashes['notes/bun-migration/performance/qualify-fixture-reuse.py'],
  planSha256: hash(readFileSync(`${directory}/launch-plan.json`)),
  ciOnly: true, testsLaunchedByMaterializer: false
}
assert.equal(context.platform, 'linux')
assert.equal(context.arch, 'arm64')
assert.ok(['bun', 'node'].includes(context.runtime))
assert.ok(plan.shuffleSeeds.includes(context.seed))
assert.equal(context.vitestVersion, '5.0.3')
writeFileSync(`${directory}/ci-context.json`, JSON.stringify(context, null, 2) + '\n', { flag: 'wx' })
