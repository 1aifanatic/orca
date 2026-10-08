// Reuses the source-bound diagnostic materializer; launches no tests.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { constants, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

assert.equal(process.env.GITHUB_ACTIONS, 'true')
const envKeys = ['ORCA_BALANCE_UNIT_SHARDS', 'ORCA_VITEST_RUNTIME', 'NODE_COMPILE_CACHE', 'NODE_DISABLE_COMPILE_CACHE', 'NODE_OPTIONS']
for (const key of envKeys) assert.equal(process.env[key], undefined, key)
assert.equal(process.env.ORCA_BACKGROUND_LAUNCH, '1')
const payload = resolve(import.meta.dirname, 'payload')
const manifestBytes = readFileSync(resolve(payload, 'definition-manifest.json'))
const manifest = JSON.parse(manifestBytes)
const hash = value => createHash('sha256').update(value).digest('hex')
const { runProcessSync } = await import(pathToFileURL(resolve('config/scripts/script-child-process.mjs')).href)
const command = (program, args) => {
  const result = runProcessSync({ program, args, timeoutMs: 10000, maxOutputBytes: 65536 })
  assert.equal(result.code, 0)
  assert.equal(result.outputTruncated, false)
  return result.stdout.trim()
}
assert.equal(process.env.WEB_TABS_SOURCE_SHA, manifest.sourceHead)
assert.equal(command('git', ['rev-parse', 'HEAD']), manifest.sourceHead)
assert.equal(command('git', ['diff', '--name-only', 'HEAD']), '')
assert.equal(process.platform, 'linux')
assert.equal(process.arch, 'arm64')
for (const [file, expected] of Object.entries(manifest.sourceHashes)) {
  assert.ok(!file.startsWith('notes/'))
  assert.equal(hash(readFileSync(file)), expected, `Named tracked source changed: ${file}`)
}
const { NODE_RUNTIME_PIN } = await import(pathToFileURL(resolve('src/shared/node-runtime-pin.ts')).href)
assert.equal(NODE_RUNTIME_PIN.version, manifest.expectedCiPins.node)
assert.equal(process.versions.node, NODE_RUNTIME_PIN.version)
assert.equal(command('bun', ['--version']), readFileSync('config/.bun-version', 'utf8').trim())
assert.equal(command('bun', ['--version']), manifest.expectedCiPins.bun)
assert.equal(JSON.parse(readFileSync('node_modules/vitest/package.json', 'utf8')).version, manifest.expectedCiPins.vitest)
for (const [name, key] of Object.entries(manifest.payloadToHashKey)) {
  assert.ok(!name.includes('/') && !name.includes('\\'))
  assert.equal(hash(readFileSync(resolve(payload, name))), manifest.payloadSha256[key], name)
}
const { NODE_RUNTIME_INCLUDE } = await import(pathToFileURL(resolve('config/scripts/vitest-node-runtime-files.mjs')).href)
assert.deepEqual(NODE_RUNTIME_INCLUDE, manifest.nodeRuntimeIncludes)
for (const [destination, name] of Object.entries(manifest.destinationToPayload)) {
  assert.ok(destination.startsWith('notes/bun-migration/performance/'))
  assert.ok(!destination.split('/').includes('..'))
  assert.ok(Object.hasOwn(manifest.payloadToHashKey, name))
  assert.equal(existsSync(destination), false, `Destination must be fresh: ${destination}`)
  mkdirSync(dirname(destination), { recursive: true })
  copyFileSync(resolve(payload, name), destination, constants.COPYFILE_EXCL)
}
const directory = manifest.isolatedDirectory
mkdirSync(resolve(directory, 'runs', process.env.WEB_TABS_RUNTIME + '-' + process.env.WEB_TABS_SEED), { recursive: true })
for (const phase of ['shipping']) {
  const planPath = resolve(directory, phase + '-launch-plan.json')
  const plan = JSON.parse(readFileSync(planPath))
  assert.equal(plan.sourceHead, manifest.sourceHead)
  assert.equal(plan.controllerSha256, manifest.controllerSha256)
  assert.equal(plan.reporterSha256, manifest.reporterSha256)
  for (const [file, expected] of Object.entries(plan.sourceHashes)) assert.equal(hash(readFileSync(file)), expected, file)
  assert.equal(hash(readFileSync(plan.patch)), plan.patchSha256)
}
const context = {
  sourceSha: manifest.sourceHead, definitionSha: process.env.GITHUB_SHA,
  runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT,
  runtime: process.env.WEB_TABS_RUNTIME, seed: Number(process.env.WEB_TABS_SEED),
  platform: process.platform, arch: process.arch, nodeVersion: process.versions.node,
  nodeExecutable: process.execPath, bunVersion: command('bun', ['--version']), bunRevision: command('bun', ['--revision']),
  vitestVersion: JSON.parse(readFileSync('node_modules/vitest/package.json', 'utf8')).version,
  launchEnvironment: Object.fromEntries(['ORCA_BACKGROUND_LAUNCH', ...envKeys].map(key => [key, process.env[key] ?? null])),
  controllerSha256: manifest.controllerSha256, reporterSha256: manifest.reporterSha256,
  shippingPlanSha256: manifest.payloadSha256.shippingLaunch,
  definitionManifestSha256: hash(manifestBytes), ciOnly: true, testsLaunchedByMaterializer: false
}
assert.ok(['bun', 'node'].includes(context.runtime))
assert.ok(manifest.shuffleSeeds.includes(context.seed))
writeFileSync(resolve(directory, 'ci-context.json'), JSON.stringify(context, null, 2) + '\n', { flag: 'wx' })
