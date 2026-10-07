// Reuses the reviewed HTTP definition materializer; launches no tests.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, matchesGlob, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

assert.equal(process.env.GITHUB_ACTIONS, 'true')
for (const key of ['ORCA_BALANCE_UNIT_SHARDS', 'ORCA_VITEST_RUNTIME', 'NODE_COMPILE_CACHE', 'NODE_DISABLE_COMPILE_CACHE', 'NODE_OPTIONS']) assert.equal(process.env[key], undefined, key)
const payload = resolve(import.meta.dirname, 'payload')
const manifest = JSON.parse(readFileSync(resolve(payload, 'definition-manifest.json'), 'utf8'))
const hash = value => createHash('sha256').update(value).digest('hex')
assert.equal(manifest.dispatchReady, true, 'Draft blocked pending exact fixture-fix source commit and independent source refreeze')
assert.equal(manifest.sourceCommitPending, false)
assert.match(manifest.sourceHead, /^[a-f0-9]{40}$/)
assert.equal(process.env.ZOD_SOURCE_SHA, manifest.sourceHead)
for (const [file, expected] of Object.entries(manifest.sourceHashes)) assert.equal(hash(readFileSync(file)), expected, file)
for (const [file, expected] of Object.entries(manifest.installedHashes)) assert.equal(hash(readFileSync(file)), expected, file)
for (const [name, expected] of Object.entries(manifest.payloadSha256)) assert.equal(hash(readFileSync(resolve(payload, name))), expected, name)
const { runProcessSync } = await import(pathToFileURL(resolve('config/scripts/script-child-process.mjs')).href)
const command = (program, args) => {
  const result = runProcessSync({ program, args, timeoutMs: 10000, maxOutputBytes: 65536 })
  assert.equal(result.code, 0)
  assert.equal(result.outputTruncated, false)
  return result.stdout.trim()
}
assert.equal(command('git', ['rev-parse', 'HEAD']), manifest.sourceHead)
assert.equal(command('git', ['diff', '--name-only', 'HEAD']), '')
assert.equal(process.platform, 'linux')
assert.equal(process.arch, 'arm64')
assert.equal(process.versions.node, '24.21.0')
assert.equal(command('bun', ['--version']), readFileSync('config/.bun-version', 'utf8').trim())
assert.ok(['bun', 'node'].includes(process.env.ZOD_RUNTIME))
assert.ok(manifest.shuffleSeeds.includes(Number(process.env.ZOD_SEED)))
const { NODE_RUNTIME_INCLUDE } = await import(pathToFileURL(resolve('config/scripts/vitest-node-runtime-files.mjs')).href)
for (const row of manifest.expectedRoutes.originalRoutes) {
  const protectedFile = NODE_RUNTIME_INCLUDE.some(pattern => matchesGlob(row.file, pattern))
  assert.equal(protectedFile, row.matchedProtectedPatterns.length > 0, row.file)
  assert.deepEqual(row.bunCoordinator, protectedFile ? { project: 'node-runtime', pool: 'node-runtime' } : { project: 'bun', pool: 'forks' })
  assert.deepEqual(row.nodeCoordinator, { project: 'node', pool: 'forks' })
}
for (const [destination, name] of Object.entries(manifest.destinationToPayload)) {
  assert.ok(destination.startsWith('notes/bun-migration/performance/'))
  assert.equal(existsSync(destination), false, 'Never overwrite: ' + destination)
  mkdirSync(dirname(destination), { recursive: true })
  copyFileSync(resolve(payload, name), destination)
}
const plan = JSON.parse(readFileSync(manifest.planPath, 'utf8'))
for (const [file, expected] of Object.entries(plan.sourceHashes)) assert.equal(hash(readFileSync(file)), expected, file)
for (const [file, expected] of Object.entries(plan.configurationSourceHashes)) assert.equal(hash(readFileSync(file)), expected, file)
assert.equal(hash(readFileSync(manifest.controllerPath)), plan.controllerCandidateSha256)
const runDirectory = resolve(manifest.epochPath, 'runs', process.env.ZOD_RUNTIME + '-' + process.env.ZOD_SEED)
mkdirSync(runDirectory, { recursive: true })
const context = {
  sourceSha: manifest.sourceHead, definitionSha: process.env.GITHUB_SHA,
  runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT,
  runtime: process.env.ZOD_RUNTIME, seed: Number(process.env.ZOD_SEED), checkoutRoot: process.cwd(),
  platform: process.platform, arch: process.arch, nodeVersion: process.versions.node, nodeExecutable: process.execPath,
  bunVersion: command('bun', ['--version']), bunRevision: command('bun', ['--revision']),
  vitestVersion: JSON.parse(readFileSync('node_modules/vitest/package.json', 'utf8')).version,
  planSha256: hash(readFileSync(manifest.planPath)), controllerSha256: plan.controllerCandidateSha256,
  beforeCacheRoot: resolve(runDirectory, 'before-cache'), afterCacheRoot: resolve(runDirectory, 'after-cache'),
  beforePrefix: manifest.epochPath + '/runs/' + process.env.ZOD_RUNTIME + '-' + process.env.ZOD_SEED + '/before',
  afterPrefix: manifest.epochPath + '/runs/' + process.env.ZOD_RUNTIME + '-' + process.env.ZOD_SEED + '/after',
  materializerLaunchedTests: false, ciOnly: true
}
assert.equal(context.vitestVersion, '5.0.3')
assert.equal(existsSync(context.beforeCacheRoot), false)
assert.equal(existsSync(context.afterCacheRoot), false)
writeFileSync(resolve(runDirectory, 'ci-context.json'), JSON.stringify(context, null, 2) + '\n', { flag: 'wx' })
