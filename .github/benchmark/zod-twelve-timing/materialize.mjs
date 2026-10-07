// Reuses the isolated Zod compatibility materializer; launches no tests.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, matchesGlob, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

assert.equal(process.env.GITHUB_ACTIONS, 'true')
for (const key of ['ORCA_BALANCE_UNIT_SHARDS', 'ORCA_VITEST_RUNTIME', 'ORCA_UNIT_SELECTION_PLAN', 'ORCA_SHARD_SOURCE_SHA', 'NODE_COMPILE_CACHE', 'NODE_DISABLE_COMPILE_CACHE', 'NODE_OPTIONS']) assert.equal(process.env[key], undefined, key)
const payload = resolve(import.meta.dirname, 'payload')
const manifest = JSON.parse(readFileSync(resolve(payload, 'definition-manifest.json'), 'utf8'))
const hash = value => createHash('sha256').update(value).digest('hex')
const plan = JSON.parse(readFileSync(resolve(payload, 'measurement-plan.json'), 'utf8'))
assert.ok(plan.compatibilityAdmission, 'Blocked draft: first fix the baseline fixture and qualify the fresh source')
assert.ok(plan.stateBoundaryAdmission, 'Blocked draft: public-state/reset audit review is separate')
assert.equal(manifest.dispatchReady, true)
assert.equal(process.env.ZOD_SOURCE_SHA, manifest.sourceHead)
assert.equal(plan.sourceHead, manifest.sourceHead)
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
assert.equal(command('bun', ['--version']), '1.4.2')
assert.equal(JSON.parse(readFileSync('node_modules/vitest/package.json', 'utf8')).version, '5.0.3')
const { NODE_RUNTIME_INCLUDE } = await import(pathToFileURL(resolve('config/scripts/vitest-node-runtime-files.mjs')).href)
assert.equal(plan.files.length, 12)
for (const route of plan.expectedModuleRoutes) {
  assert.equal(NODE_RUNTIME_INCLUDE.some(pattern => matchesGlob(route.file, pattern)), false)
  assert.deepEqual(route, { file: route.file, project: 'bun', pool: 'forks' })
}
for (const [destination, name] of Object.entries(manifest.destinationToPayload)) {
  assert.ok(destination.startsWith('notes/bun-migration/performance/'))
  assert.equal(existsSync(destination), false, 'Never overwrite: ' + destination)
  mkdirSync(dirname(destination), { recursive: true })
  copyFileSync(resolve(payload, name), destination)
}
for (const [file, expected] of Object.entries(plan.configurationSourceHashes)) assert.equal(hash(readFileSync(file)), expected, file)
for (const [file, expected] of Object.entries(plan.identityProofFiles)) assert.equal(hash(readFileSync(file)), expected, file)
assert.equal(hash(readFileSync(manifest.driverPath)), manifest.driverSha256)
const admission = JSON.parse(readFileSync(plan.compatibilityAdmission.path, 'utf8'))
assert.equal(hash(readFileSync(plan.compatibilityAdmission.path)), plan.compatibilityAdmission.sha256)
assert.equal(admission.broadCompatibilityQualified, true)
assert.equal(admission.sourceHead, plan.sourceHead)
assert.equal(admission.snapshots.length, 8)
for (const snapshot of admission.snapshots) {
  for (const file of plan.files) assert.deepEqual(snapshot.map[file], plan.caseIdentityMapByFile[file])
}
const stateBoundary = JSON.parse(readFileSync(plan.stateBoundaryAdmission.path, 'utf8'))
assert.equal(hash(readFileSync(plan.stateBoundaryAdmission.path)), plan.stateBoundaryAdmission.sha256)
assert.equal(stateBoundary.sourceHead, plan.sourceHead)
assert.equal(stateBoundary.reviewedForTimingAdmission, true)
const runDirectory = resolve(plan.cacheRootPrefix, process.env.GITHUB_RUN_ID + '-' + process.env.GITHUB_RUN_ATTEMPT)
assert.equal(existsSync(runDirectory), false, 'Never reuse or evict a cold timing root')
mkdirSync(runDirectory, { recursive: true })
const context = {
  sourceSha: manifest.sourceHead, definitionSha: process.env.GITHUB_SHA,
  runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT,
  platform: process.platform, arch: process.arch, nodeVersion: process.versions.node, nodeExecutable: process.execPath,
  bunRevision: command('bun', ['--revision']), vitestVersion: '5.0.3',
  planSha256: hash(readFileSync(manifest.planPath)), driverSha256: manifest.driverSha256,
  beforeCacheRoot: resolve(runDirectory, 'before-cache'), afterCacheRoot: resolve(runDirectory, 'after-cache'),
  ciOnly: true, materializerLaunchedTests: false, coldCommandsCounted: true, fsModuleCache: false
}
assert.equal(existsSync(context.beforeCacheRoot), false)
assert.equal(existsSync(context.afterCacheRoot), false)
writeFileSync(resolve(runDirectory, 'ci-context.json'), JSON.stringify(context, null, 2) + '\n', { flag: 'wx' })
