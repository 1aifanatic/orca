// Reuses the source-bound diagnostic materializer; launches no tests.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { constants, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, matchesGlob, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

assert.equal(process.env.GITHUB_ACTIONS, 'true')
const envKeys = ['ORCA_BALANCE_UNIT_SHARDS', 'ORCA_VITEST_RUNTIME', 'NODE_COMPILE_CACHE', 'NODE_DISABLE_COMPILE_CACHE', 'NODE_OPTIONS']
for (const key of [...envKeys, 'BUN_OPTIONS', 'BUN_INSPECT_PRELOAD']) assert.equal(process.env[key], undefined, key)
assert.equal(Object.keys(process.env).filter(key => key.startsWith('BUN_TEST_')).length, 0)
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
assert.equal(process.env.WAIT_SOURCE_SHA, manifest.sourceHead)
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
assert.equal(command('bun', ['--revision']), manifest.expectedBunRevision)
for (const [file, expected] of Object.entries(manifest.installedOwnerHashes)) assert.equal(hash(readFileSync(file)), expected, file)
for (const [name, key] of Object.entries(manifest.payloadToHashKey)) {
  assert.ok(!name.includes('/') && !name.includes('\\'))
  assert.equal(hash(readFileSync(resolve(payload, name))), manifest.payloadSha256[key], name)
}
const { NODE_RUNTIME_INCLUDE } = await import(pathToFileURL(resolve('config/scripts/vitest-node-runtime-files.mjs')).href)
assert.deepEqual(NODE_RUNTIME_INCLUDE, manifest.nodeRuntimeIncludes)
for (const file of manifest.pureFiles.concat('config/scripts/vitest-real-agent-home-write-guard.test.ts')) assert.equal(manifest.nodeRuntimeIncludes.some(pattern => matchesGlob(file, pattern)), false, 'Small fixtures remain ordinary Bun/forks')
for (const [destination, name] of Object.entries(manifest.destinationToPayload)) {
  assert.ok(destination.startsWith('notes/bun-migration/performance/'))
  assert.ok(!destination.split('/').includes('..'))
  assert.ok(Object.hasOwn(manifest.payloadToHashKey, name))
  assert.equal(existsSync(destination), false, `Destination must be fresh: ${destination}`)
  mkdirSync(dirname(destination), { recursive: true })
  copyFileSync(resolve(payload, name), destination, constants.COPYFILE_EXCL)
}
const directory = manifest.isolatedDirectory
for (const [name, expected] of Object.entries(manifest.nativeFixtures)) {
  const source = resolve(payload, 'fixtures', name)
  const destination = resolve(directory, 'fixtures', name)
  assert.equal(hash(readFileSync(source)), expected)
  assert.equal(existsSync(destination), false)
  mkdirSync(dirname(destination), { recursive: true })
  copyFileSync(source, destination, constants.COPYFILE_EXCL)
}
const manifestDestination = resolve(directory, 'definition-manifest.json')
assert.equal(existsSync(manifestDestination), false)
copyFileSync(resolve(payload, 'definition-manifest.json'), manifestDestination, constants.COPYFILE_EXCL)
mkdirSync(resolve(directory, 'native'), { recursive: true })
const plan = JSON.parse(readFileSync(resolve(directory, 'shipping-launch-plan.json')))
assert.equal(plan.sourceHead, manifest.sourceHead)
assert.equal(plan.controllerSha256, manifest.controllerSha256)
assert.equal(plan.reporterSha256, manifest.reporterSha256)
for (const [file, expected] of Object.entries(plan.sourceHashes)) assert.equal(hash(readFileSync(file)), expected, file)
assert.equal(hash(readFileSync(plan.patch)), plan.patchSha256)
const bunExecutable = command('which', ['bun'])
const context = {
  sourceSha: manifest.sourceHead, definitionSha: process.env.GITHUB_SHA,
  runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT,
  runtime: 'single-host', seed: null,
  platform: process.platform, arch: process.arch, nodeVersion: process.versions.node,
  nodeExecutable: process.execPath, bunVersion: command('bun', ['--version']), bunRevision: command('bun', ['--revision']),
  bunExecutable, bunExecutableSha256: hash(readFileSync(bunExecutable)),
  vitestVersion: JSON.parse(readFileSync('node_modules/vitest/package.json', 'utf8')).version,
  launchEnvironment: Object.fromEntries(['ORCA_BACKGROUND_LAUNCH', ...envKeys].map(key => [key, process.env[key] ?? null])),
  controllerSha256: manifest.controllerSha256, reporterSha256: manifest.reporterSha256,
  shippingPlanSha256: manifest.payloadSha256.shippingLaunch,
  definitionManifestSha256: hash(manifestBytes), installedOwnerHashes: manifest.installedOwnerHashes,
  ciOnly: true, testsLaunchedByMaterializer: false
}
writeFileSync(resolve(directory, 'single-host-ci-context.json'), JSON.stringify(context, null, 2) + '\n', { flag: 'wx' })
for (const runtime of ['bun', 'node']) for (const seed of manifest.shuffleSeeds) {
  const destination = resolve(directory, 'stock', `bun-native-five-pure-guard-stock-${runtime}-${seed}`)
  mkdirSync(resolve(destination, 'runs', runtime + '-' + seed), { recursive: true })
  for (const name of ['shipping-launch-plan.json', 'shipping.patch', 'source-proposal-proof.json'])
    copyFileSync(resolve(directory, name), resolve(destination, name), constants.COPYFILE_EXCL)
  writeFileSync(resolve(destination, 'ci-context.json'), JSON.stringify({ ...context, runtime, seed }, null, 2) + '\n', { flag: 'wx' })
}
writeFileSync(process.env.GITHUB_ENV, `ORCA_TEST_NODE_EXECUTABLE=${process.execPath}\nORCA_TEST_NODE_VERSION=${process.versions.node}\nNATIVE_BUN_EXECUTABLE=${bunExecutable}\n`, { flag: 'a' })
