// Install a reviewed probe on a disposable checkout; launches no tests.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { constants, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { cpus } from 'node:os'
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
assert.equal(command('bun', ['--revision']), manifest.expectedBunRevisionDisplay)
assert.equal(readFileSync('config/.bun-version', 'utf8').trim(), manifest.expectedCiPins.bun)
assert.equal(JSON.parse(readFileSync('node_modules/vitest/package.json')).version, manifest.expectedCiPins.vitest)
assert.equal(command('git', ['diff', '--name-only', 'HEAD']), '')
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
  assert.ok(destination.startsWith('notes/bun-migration/performance/'))
  assert.ok(!destination.split('/').includes('..'))
  assert.ok(Object.hasOwn(manifest.payloadSha256, name))
  assert.equal(existsSync(destination), false, `Fresh destination required: ${destination}`)
  mkdirSync(dirname(destination), { recursive: true })
  copyFileSync(resolve(payload, name), destination, constants.COPYFILE_EXCL)
}
assert.equal(command('git', ['diff', '--name-only', 'HEAD']), '')
assert.equal(process.env.SHARED_SERVER_SOURCE_SHA, manifest.sourceHead)
const plan = JSON.parse(readFileSync(resolve(manifest.isolatedDirectory, 'measurement-plan.json')))
assert.equal(plan.files.length, 1187)
assert.equal(plan.caseCount, null)
assert.equal(plan.caseIdentityMapByFile, null)
assert.equal(plan.runtimeManifestPending, true)
for (const key of manifest.absentProfilingEnvironment) assert.equal(process.env[key], undefined, key)
const actual = JSON.parse(readFileSync(resolve(manifest.isolatedDirectory, 'actual-eight-result.json')))
assert.equal(actual.qualified, true)
assert.equal(actual.sourceHead, manifest.sourceHead)
assert.equal(actual.runtimeDerivedCaseCount, 296)
assert.equal(actual.originalRuntimeDerivedCaseCount, 278)
assert.equal(actual.snapshots.length, 8)
assert.equal(actual.candidateAddsNoCases, true)
const independent = JSON.parse(readFileSync(resolve(manifest.isolatedDirectory, 'independent-eight-proof.json')))
assert.equal(independent.qualified, true)
assert.equal(independent.actualCollectorSemanticResultEqualsIndependentRawReplay, true)
assert.equal(independent.runId, manifest.actualQualificationRun)
assert.equal(independent.definitionSha, manifest.actualQualificationDefinition)
for (const [file, expected] of Object.entries(plan.sourceBeforeSha256)) assert.equal(hash(readFileSync(file)), expected, file)
assert.equal(hash(readFileSync(plan.patch)), plan.patchSha256)
assert.equal(cpus().length, 4)
const context = { sourceSha: manifest.sourceHead, definitionSha: process.env.GITHUB_SHA, runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT,
 logicalCpus: cpus().length, absentProfilingEnvironment: Object.fromEntries(manifest.absentProfilingEnvironment.map(key => [key, process.env[key] ?? null])),
 repositoryRoot: process.cwd(), platform: process.platform, arch: process.arch, nodeVersion: process.versions.node, nodeExecutable: process.execPath,
 bunVersion: command('bun', ['--version']), bunRevisionDisplay: command('bun', ['--revision']), expectedBunRuntimeRevision: manifest.expectedBunRuntimeRevision,
 vitestVersion: manifest.expectedCiPins.vitest, controllerSha256: manifest.controllerSha256, reporterSha256: manifest.reporterSha256,
 definitionManifestSha256: hash(bytes), planSha256: hash(readFileSync(resolve(manifest.isolatedDirectory, 'measurement-plan.json'))),
 launchEnvironment: Object.fromEntries(['ORCA_BACKGROUND_LAUNCH', ...envKeys].map(key => [key, process.env[key] ?? null])),
 qualificationRun: manifest.actualQualificationRun, ciOnly: true, testsLaunchedByMaterializer: false }
writeFileSync(resolve(manifest.isolatedDirectory, 'ci-context.json'), JSON.stringify(context, null, 2) + '\n', { flag: 'wx' })
