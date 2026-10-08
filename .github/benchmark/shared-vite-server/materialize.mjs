// Install a reviewed probe on a disposable checkout; launches no tests.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { constants, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

assert.equal(process.env.GITHUB_ACTIONS, 'true')
assert.equal(process.env.ORCA_BACKGROUND_LAUNCH, '1')
const envKeys = ['ORCA_BALANCE_UNIT_SHARDS', 'ORCA_VITEST_RUNTIME', 'NODE_COMPILE_CACHE', 'NODE_DISABLE_COMPILE_CACHE', 'NODE_OPTIONS']
for (const key of envKeys) assert.equal(process.env[key], undefined, key)
const payload = resolve(import.meta.dirname, 'payload')
const bytes = readFileSync(resolve(payload, 'definition-manifest.json'))
const manifest = JSON.parse(bytes)
const hash = value => createHash('sha256').update(value).digest('hex')
const { runProcessSync } = await import(pathToFileURL(resolve('config/scripts/script-child-process.mjs')).href)
const command = (program, args) => {
  const result = runProcessSync({ program, args, timeoutMs: 20000, maxOutputBytes: 65536,
    env: { ...process.env, GIT_NO_LAZY_FETCH: '1', GIT_OPTIONAL_LOCKS: '0' } })
  assert.equal(result.code, 0)
  assert.equal(result.outputTruncated, false)
  return result.stdout.trim()
}
assert.equal(process.env.SHARED_SERVER_SOURCE_SHA, manifest.sourceHead)
assert.equal(command('git', ['rev-parse', 'HEAD']), manifest.sourceHead)
assert.equal(command('git', ['diff', '--name-only', 'HEAD']), '')
assert.equal(process.platform, 'linux')
assert.equal(process.arch, 'arm64')
assert.equal(process.versions.node, manifest.expectedCiPins.node)
assert.equal(command('bun', ['--version']), manifest.expectedCiPins.bun)
assert.equal(readFileSync('config/.bun-version', 'utf8').trim(), manifest.expectedCiPins.bun)
assert.equal(JSON.parse(readFileSync('node_modules/vitest/package.json')).version, manifest.expectedCiPins.vitest)
for (const [file, expected] of Object.entries(manifest.sourceHashes)) {
  assert.equal(hash(readFileSync(file)), expected, `Named source changed: ${file}`)
}
for (const [file, expected] of Object.entries(manifest.installedSourceOwners)) {
  assert.equal(hash(readFileSync(file)), expected, `Installed API changed: ${file}`)
}
for (const [name, expected] of Object.entries(manifest.payloadSha256)) {
  assert.ok(!name.includes('/') && !name.includes('\\'))
  assert.equal(hash(readFileSync(resolve(payload, name))), expected, name)
}
for (const [destination, name] of Object.entries(manifest.destinationToPayload)) {
  assert.ok(destination.startsWith('notes/bun-migration/performance/') || destination.startsWith(manifest.probeDirectory + '/'))
  assert.ok(!destination.split('/').includes('..'))
  assert.ok(Object.hasOwn(manifest.payloadSha256, name))
  assert.equal(existsSync(destination), false, `Fresh destination required: ${destination}`)
  mkdirSync(dirname(destination), { recursive: true })
  copyFileSync(resolve(payload, name), destination, constants.COPYFILE_EXCL)
}
assert.equal(hash(readFileSync('config/vitest.config.ts')), manifest.functionalBeforeSha256)
writeFileSync('config/vitest.config.ts', readFileSync(resolve(payload, 'baseline-config.ts')))
assert.equal(hash(readFileSync('config/vitest.config.ts')), manifest.beforeConfigurationSha256)
for (const [file, expected] of Object.entries(manifest.probeSourceHashes)) assert.equal(hash(readFileSync(file)), expected)
for (const runtime of ['bun', 'node']) for (const seed of manifest.shuffleSeeds) {
  mkdirSync(resolve(manifest.isolatedDirectory, 'runs', runtime + '-' + seed), { recursive: true })
}
const planPath = resolve(manifest.isolatedDirectory, 'shipping-launch-plan.json')
const plan = JSON.parse(readFileSync(planPath))
assert.equal(hash(readFileSync(planPath)), manifest.payloadSha256['shipping-launch-plan.json'])
assert.equal(plan.controllerSha256, manifest.controllerSha256)
assert.equal(plan.reporterSha256, manifest.reporterSha256)
for (const [file, expected] of Object.entries(plan.sourceHashes)) assert.equal(hash(readFileSync(file)), expected, file)
assert.equal(hash(readFileSync(plan.patch)), plan.patchSha256)
const context = {
  sourceSha: manifest.sourceHead, definitionSha: process.env.GITHUB_SHA,
  runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT,
  platform: process.platform, arch: process.arch, nodeVersion: process.versions.node,
  nodeExecutable: process.execPath, bunVersion: command('bun', ['--version']), bunRevision: command('bun', ['--revision']),
  vitestVersion: JSON.parse(readFileSync('node_modules/vitest/package.json')).version,
  launchEnvironment: Object.fromEntries(['ORCA_BACKGROUND_LAUNCH', ...envKeys].map(key => [key, process.env[key] ?? null])),
  controllerSha256: manifest.controllerSha256, reporterSha256: manifest.reporterSha256,
  shippingPlanSha256: manifest.payloadSha256['shipping-launch-plan.json'],
  definitionManifestSha256: hash(bytes), ciOnly: true, testsLaunchedByMaterializer: false,
  allEightCommandsOnOneHeldHost: true
}
for (const key of ['sourceSha', 'definitionSha', 'runId', 'runAttempt']) assert.match(context[key], key.includes('Sha') ? /^[a-f0-9]{40}$/ : /^[1-9][0-9]*$/)
writeFileSync(resolve(manifest.isolatedDirectory, 'ci-context.json'), JSON.stringify(context, null, 2) + '\n', { flag: 'wx' })
assert.ok(process.env.GITHUB_ENV)
assert.ok(!process.execPath.includes('\n'))
writeFileSync(process.env.GITHUB_ENV, `ORCA_TEST_NODE_EXECUTABLE=${process.execPath}\nORCA_TEST_NODE_VERSION=${process.versions.node}\n`, { flag: 'a' })
