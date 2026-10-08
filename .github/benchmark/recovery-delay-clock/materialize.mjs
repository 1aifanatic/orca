// Source-bound materialization only; reuses the reviewed retry qualifier/held controllers.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { constants, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { cpus } from 'node:os'
import { dirname, matchesGlob, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
assert.equal(process.env.GITHUB_ACTIONS, 'true')
assert.equal(process.env.ORCA_BACKGROUND_LAUNCH, '1')
const envKeys = ['ORCA_BALANCE_UNIT_SHARDS', 'ORCA_VITEST_RUNTIME', 'NODE_COMPILE_CACHE', 'NODE_DISABLE_COMPILE_CACHE', 'NODE_OPTIONS']
for (const key of envKeys) assert.equal(process.env[key], undefined, key)
const payload = resolve(import.meta.dirname, 'payload')
const manifestBytes = readFileSync(resolve(payload, 'definition-manifest.json'))
const manifest = JSON.parse(manifestBytes)
const hash = value => createHash('sha256').update(value).digest('hex')
const { runProcessSync } = await import(pathToFileURL(resolve('config/scripts/script-child-process.mjs')).href)
const command = (program, args) => {
  const result = runProcessSync({ program, args, timeoutMs: 20000, maxOutputBytes: 65536 })
  assert.equal(result.code, 0)
  assert.equal(result.outputTruncated, false)
  return result.stdout.trim()
}
assert.equal(process.env.WAIT_SOURCE_SHA, manifest.sourceHead)
assert.equal(command('git', ['rev-parse', 'HEAD']), manifest.sourceHead)
assert.equal(command('git', ['diff', '--name-only', 'HEAD']), '')
assert.equal(process.platform, 'linux')
assert.equal(process.arch, 'arm64')
assert.equal(cpus().length, 4)
for (const [file, expected] of Object.entries(manifest.sourceHashes)) {
  assert.ok(!file.startsWith('notes/'))
  assert.equal(hash(readFileSync(file)), expected, file)
}
const { NODE_RUNTIME_PIN } = await import(pathToFileURL(resolve('src/shared/node-runtime-pin.ts')).href)
assert.equal(process.versions.node, manifest.expectedCiPins.node)
assert.equal(NODE_RUNTIME_PIN.version, manifest.expectedCiPins.node)
assert.equal(command('bun', ['--version']), manifest.expectedCiPins.bun)
assert.equal(readFileSync('config/.bun-version', 'utf8').trim(), manifest.expectedCiPins.bun)
assert.equal(JSON.parse(readFileSync('node_modules/vitest/package.json', 'utf8')).version, manifest.expectedCiPins.vitest)
const { NODE_RUNTIME_INCLUDE } = await import(pathToFileURL(resolve('config/scripts/vitest-node-runtime-files.mjs')).href)
assert.equal(NODE_RUNTIME_INCLUDE.some(pattern => matchesGlob(manifest.files[0], pattern)), true, 'Existing actual-Node boundary must remain')
for (const [name, key] of Object.entries(manifest.payloadToHashKey)) {
  assert.ok(!name.includes('/') && !name.includes('\\'))
  assert.equal(hash(readFileSync(resolve(payload, name))), manifest.payloadSha256[key], name)
}
for (const [destination, name] of Object.entries(manifest.destinationToPayload)) {
  assert.ok(destination.startsWith('notes/bun-migration/performance/'))
  assert.ok(!destination.split('/').includes('..'))
  assert.equal(existsSync(destination), false, destination)
  mkdirSync(dirname(destination), { recursive: true })
  copyFileSync(resolve(payload, name), destination, constants.COPYFILE_EXCL)
}
const directory = manifest.isolatedDirectory
writeFileSync(resolve(directory, 'definition-manifest.json'), manifestBytes, { flag: 'wx' })
const plan = JSON.parse(readFileSync(resolve(directory, 'shipping-launch-plan.json')))
assert.equal(plan.sourceHead, manifest.sourceHead)
assert.equal(plan.controllerSha256, manifest.controllerSha256)
assert.equal(plan.reporterSha256, manifest.reporterSha256)
for (const [file, expected] of Object.entries(plan.sourceHashes)) assert.equal(hash(readFileSync(file)), expected, file)
assert.equal(hash(readFileSync(plan.patch)), plan.patchSha256)
const common = {
  sourceSha: manifest.sourceHead, definitionSha: process.env.GITHUB_SHA,
  runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT,
  platform: process.platform, arch: process.arch, nodeVersion: process.versions.node,
  nodeExecutable: process.execPath, nodeExecutableSha256: hash(readFileSync(process.execPath)), bunVersion: command('bun', ['--version']), bunRevision: command('bun', ['--revision']),
  vitestVersion: JSON.parse(readFileSync('node_modules/vitest/package.json', 'utf8')).version,
  launchEnvironment: Object.fromEntries(['ORCA_BACKGROUND_LAUNCH', ...envKeys].map(key => [key, process.env[key] ?? null])),
  definitionManifestSha256: hash(manifestBytes), ciOnly: true, testsLaunchedByMaterializer: false
}
assert.match(common.runId, /^\d+$/)
assert.match(common.runAttempt, /^\d+$/)
assert.match(common.definitionSha, /^[a-f0-9]{40}$/)
for (const runtime of ['bun', 'node']) for (const seed of manifest.shuffleSeeds) {
  const view = resolve(directory, 'qualification-artifacts', 'recovery-delay-clock-' + runtime + '-' + seed)
  mkdirSync(resolve(view, 'runs', runtime + '-' + seed), { recursive: true })
  mkdirSync(resolve(directory, 'runs', runtime + '-' + seed), { recursive: true })
  for (const name of ['shipping-launch-plan.json', 'shipping.patch', 'source-proposal-proof.json']) copyFileSync(resolve(directory, name), resolve(view, name), constants.COPYFILE_EXCL)
  writeFileSync(resolve(view, 'ci-context.json'), JSON.stringify({ ...common, runtime, seed,
    controllerSha256: manifest.controllerSha256, reporterSha256: manifest.reporterSha256,
    shippingPlanSha256: manifest.payloadSha256.shippingLaunch }, null, 2) + '\n', { flag: 'wx' })
}
writeFileSync(resolve(directory, 'held-context-before-admission.json'), JSON.stringify({ ...common,
  repositoryRoot: process.cwd(), logicalCpus: cpus().length, cpuModel: cpus()[0].model,
  driverSha256: manifest.timingControllerSha256, reporterSha256: manifest.reporterSha256,
  absentProfilingEnvironment: Object.fromEntries(manifest.absentProfilingEnvironment.map(key => [key, process.env[key] ?? null]))
}, null, 2) + '\n', { flag: 'wx' })
for (const key of manifest.absentProfilingEnvironment) assert.equal(process.env[key], undefined, key)
