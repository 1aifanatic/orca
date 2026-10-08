// Reuses the reviewed source-bound materializer; launches no tests.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { constants, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, matchesGlob, resolve } from 'node:path'
import { cpus } from 'node:os'
import { pathToFileURL } from 'node:url'

assert.equal(process.env.GITHUB_ACTIONS, 'true')
for (const key of ['GITHUB_SHA', 'WAIT_TIMING_SOURCE_SHA']) assert.match(process.env[key], /^[a-f0-9]{40}$/)
for (const key of ['GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT']) assert.match(process.env[key], /^[1-9][0-9]*$/)
const envKeys = ['ORCA_BALANCE_UNIT_SHARDS', 'ORCA_VITEST_RUNTIME', 'NODE_COMPILE_CACHE', 'NODE_DISABLE_COMPILE_CACHE', 'NODE_OPTIONS', 'ORCA_UNIT_SELECTION_PLAN', 'ORCA_SHARD_SOURCE_SHA', 'ORCA_SHARD_MANIFEST', 'ORCA_IMPORT_REUSE_BENCH_EXPECTED_HEAD']
for (const key of envKeys) assert.equal(process.env[key], undefined, key)
assert.equal(process.env.ORCA_BACKGROUND_LAUNCH, '1')
const payload = resolve(import.meta.dirname, 'payload')
const manifestBytes = readFileSync(resolve(payload, 'definition-manifest.json'))
const manifest = JSON.parse(manifestBytes)
assert.equal(manifest.runtimeQualificationPending, false, 'Actual eight-report correctness admission required')
const hash = value => createHash('sha256').update(value).digest('hex')
const { runProcessSync } = await import(pathToFileURL(resolve('config/scripts/script-child-process.mjs')).href)
const command = (program, args) => {
  const result = runProcessSync({ program, args, timeoutMs: 10000, maxOutputBytes: 65536 })
  assert.equal(result.code, 0)
  assert.equal(result.outputTruncated, false)
  return result.stdout.trim()
}
assert.equal(process.env.WAIT_TIMING_SOURCE_SHA, manifest.sourceHead)
assert.equal(command('git', ['rev-parse', 'HEAD']), manifest.sourceHead)
assert.equal(command('git', ['diff', '--name-only', 'HEAD']), '')
for (const key of manifest.absentProfilingEnvironment) assert.equal(process.env[key], undefined, key)
const { NODE_RUNTIME_INCLUDE } = await import(pathToFileURL(resolve('config/scripts/vitest-node-runtime-files.mjs')).href)
assert.deepEqual(NODE_RUNTIME_INCLUDE, manifest.nodeRuntimeIncludes)
for (const file of JSON.parse(readFileSync(resolve(payload, 'measurement-plan.json'))).files) assert.equal(NODE_RUNTIME_INCLUDE.some(pattern => matchesGlob(file, pattern)), false)
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
for (const [name, expected] of Object.entries(manifest.payloadSha256)) {
  assert.ok(!name.includes('/') && !name.includes('\\'))
  assert.equal(hash(readFileSync(resolve(payload, name))), expected, name)
}
for (const [destination, name] of Object.entries(manifest.destinationToPayload)) {
  assert.ok(destination.startsWith('notes/bun-migration/performance/'))
  assert.ok(!destination.split('/').includes('..'))
  assert.ok(Object.hasOwn(manifest.payloadSha256, name))
  assert.equal(existsSync(destination), false, `Destination must be fresh: ${destination}`)
  mkdirSync(dirname(destination), { recursive: true })
  copyFileSync(resolve(payload, name), destination, constants.COPYFILE_EXCL)
}
const directory = manifest.isolatedDirectory
const plan = JSON.parse(readFileSync(resolve(directory, 'measurement-plan.json')))
const independent = JSON.parse(readFileSync(resolve(directory, 'independent-runtime-proof.json')))
const actual = JSON.parse(readFileSync(resolve(directory, 'actual-ci-runtime-result.json')))
const terminal = JSON.parse(readFileSync(resolve(directory, 'terminal-ci-proof.json')))
assert.equal(actual.qualified, true)
assert.equal(independent.qualified, true)
const rootArchiveReplay = JSON.parse(readFileSync(resolve(directory, 'root-archive-replay-proof.json')))
assert.equal(terminal.runId, manifest.actualQualificationRun)
assert.equal(terminal.conclusion, 'success')
assert.equal(rootArchiveReplay.officialEvidenceMapEqualsRoot, true)
assert.equal(rootArchiveReplay.all8PassedCaseMapsEqual, true)
assert.equal(rootArchiveReplay.files, 62)
assert.equal(rootArchiveReplay.cases, 513)
assert.equal(rootArchiveReplay.rootProofSha256, hash(readFileSync(resolve(directory, 'actual-ci-runtime-result.json'))))
assert.equal(independent.runId, manifest.actualQualificationRun)
assert.equal(independent.definitionSha, manifest.actualQualificationDefinition)
assert.equal(independent.sourceHead, manifest.sourceHead)
assert.equal(independent.rootProofSha256, rootArchiveReplay.rootProofSha256)
assert.equal(independent.commands.length, 8)
assert.equal(independent.allEightDuplicatePreservingRawMapsEqual, true)
assert.equal(independent.allSourceCommandPinsSettingsRoutesLifecycleGatesPassed, true)
assert.equal(independent.runtimeDerivedCases, 513)
assert.equal(independent.files, 62)
assert.equal(actual.sourceHead, manifest.sourceHead)
assert.equal(actual.snapshots.length, 8)
assert.equal(actual.allEightOriginalCandidateSourceCommandProcessRuntimeConfigCaseStatusMapsEqual, true)
assert.equal(actual.runtimeDerivedCaseCount, 513)
assert.equal(actual.candidateAddsNoCases, true)
assert.deepEqual(actual.files, plan.files)
assert.deepEqual(plan.caseIdentityMapByFile, actual.caseIdentityMapByFile)
for (const snapshot of actual.snapshots) {
  assert.equal(snapshot.count, plan.caseCount)
  assert.deepEqual(snapshot.map, plan.caseIdentityMapByFile)
}
assert.equal(plan.caseCount, 513)
assert.ok(Number.isInteger(plan.caseCount) && plan.caseCount > 0)
assert.equal(plan.sourceHead, manifest.sourceHead)
assert.equal(plan.driverChanges, false)
assert.equal(plan.fsModuleCache, true)
assert.equal(plan.maxWorkers, 4)
assert.equal(plan.runtimeManifestPending, false)
assert.deepEqual(plan.schedule, [['before', 0], ['after', 0], ['after', 1], ['before', 1], ['before', 2], ['after', 2]])
for (const [file, expected] of Object.entries(plan.sourceBeforeSha256)) assert.equal(hash(readFileSync(file)), expected, file)
for (const [file, expected] of Object.entries(plan.identityProofFiles)) assert.equal(hash(readFileSync(file)), expected, file)
assert.equal(hash(readFileSync(plan.patch)), plan.patchSha256)
assert.equal(cpus().length, 4)
const context = {
  sourceSha: manifest.sourceHead, definitionSha: process.env.GITHUB_SHA,
  runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT,
  repositoryRoot: process.cwd(), platform: process.platform, arch: process.arch, logicalCpus: cpus().length, cpuModel: cpus()[0].model,
  nodeVersion: process.versions.node, nodeExecutable: process.execPath,
  bunVersion: command('bun', ['--version']), bunRevision: command('bun', ['--revision']),
  vitestVersion: JSON.parse(readFileSync('node_modules/vitest/package.json', 'utf8')).version,
  absentProfilingEnvironment: Object.fromEntries(manifest.absentProfilingEnvironment.map(key => [key, process.env[key] ?? null])),
  launchEnvironment: Object.fromEntries(['ORCA_BACKGROUND_LAUNCH', ...envKeys].map(key => [key, process.env[key] ?? null])),
  driverSha256: manifest.controllerSha256, reporterSha256: manifest.reporterSha256,
  definitionManifestSha256: hash(manifestBytes), planSha256: hash(readFileSync(resolve(directory, 'measurement-plan.json'))),
  ciOnly: true, testsLaunchedByMaterializer: false, qualificationRun: manifest.actualQualificationRun
}
writeFileSync(resolve(directory, 'ci-context.json'), JSON.stringify(context, null, 2) + '\n', { flag: 'wx' })
