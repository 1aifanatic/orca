import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { constants, existsSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

assert.equal(process.env.GITHUB_ACTIONS, 'true')
for (const key of ['BUN_CPU_PROFILE','BUN_CPU_PROFILE_DIR','BUN_CPU_PROFILE_NAME','BUN_OPTIONS','NODE_OPTIONS','NODE_COMPILE_CACHE','NODE_DISABLE_COMPILE_CACHE','SERIALIZE_TRANSCRIPT_DIR','SERIALIZE_TRANSCRIPT_SEEDS','ORCA_OLD_SERIALIZE_ADDON','ORCA_NEW_SERIALIZE_ADDON']) assert.equal(process.env[key], undefined, key)
assert.match(process.env.BENCH_SOURCE_SHA ?? '', /^[a-f0-9]{40}$/)
const payload = resolve(import.meta.dirname, 'payload')
const directory = 'notes/bun-migration/performance'
const proposal = `${directory}/serialize-grid-cpu-attribution-diagnostic`
assert.equal(existsSync(proposal), false, 'Owned materialized root must be absent')
const plan = JSON.parse(readFileSync(resolve(payload, 'measurement-plan.json'), 'utf8'))
assert.equal(plan.sourceSha, process.env.BENCH_SOURCE_SHA)
const { runProcessSync } = await import(pathToFileURL(resolve('config/scripts/script-child-process.mjs')).href)
const sourceHead = runProcessSync({ program: 'git', args: ['rev-parse', 'HEAD'], timeoutMs: 5000, maxOutputBytes: 65536 })
assert.equal(sourceHead.code, 0)
assert.equal(sourceHead.outputTruncated, false)
assert.equal(sourceHead.stdout.trim(), plan.sourceSha)
assert.equal(process.versions.node, plan.nodeVersion)
const hash = value => createHash('sha256').update(value).digest('hex')
assert.deepStrictEqual(Object.keys(plan.payloadSha256).sort(), ['benchmark-matched-shard.mjs', 'current-main-manifest.json', 'persistence-import-reuse-benchmark-reporter.mjs', 'unprofiled-case-proof.json'])
for (const [name, expected] of Object.entries(plan.payloadSha256)) {
  assert.equal(hash(readFileSync(resolve(payload, name))), expected, `Reviewed payload changed: ${name}`)
}
for (const [name, expected] of Object.entries(plan.installedOwnerHashes)) assert.equal(hash(readFileSync(name)), expected, `Installed owner changed: ${name}`)
for (const [name, expected] of Object.entries(plan.sourceSha256)) {
  assert.equal(hash(readFileSync(name)), expected, `Frozen source changed: ${name}`)
}
mkdirSync(proposal, { recursive: true }); mkdirSync(`${proposal}/owned-cpu-profiles`, { recursive: false })
copyFileSync(resolve(payload, 'benchmark-matched-shard.mjs'), `${proposal}/benchmark-matched-shard.mjs`, constants.COPYFILE_EXCL)
assert.equal(existsSync(`${directory}/persistence-import-reuse-benchmark-reporter.mjs`), false); copyFileSync(resolve(payload, 'persistence-import-reuse-benchmark-reporter.mjs'), `${directory}/persistence-import-reuse-benchmark-reporter.mjs`, constants.COPYFILE_EXCL)
copyFileSync(resolve(payload, 'current-main-manifest.json'), `${proposal}/current-main-manifest.json`, constants.COPYFILE_EXCL)
const manifest = JSON.parse(readFileSync(`${proposal}/current-main-manifest.json`, 'utf8'))
assert.equal(manifest.sourceSha, plan.sourceSha)
assert.equal(manifest.files.length, plan.physicalFiles)
assert.equal(manifest.files.length, 1)
assert.equal(manifest.fullFiles.length, plan.fullDiscoveryPhysicalFiles)
assert.ok(manifest.files.every(file => manifest.fullFiles.includes(file)))
assert.equal(manifest.files.includes(plan.measurementFile), false)
const { UNIT_INCLUDE, UNIT_EXCLUDE, discoverUnitFiles } = await import(pathToFileURL(resolve('config/scripts/ci-unit-files.mjs')).href)
assert.deepStrictEqual(manifest.includes, UNIT_INCLUDE, 'Manifest include patterns differ from the actual stock export')
assert.deepStrictEqual(manifest.excludes, UNIT_EXCLUDE, 'Manifest exclusions differ from the actual stock export')
assert.deepStrictEqual(manifest.fullFiles, discoverUnitFiles(), 'Frozen discovery must retain every actual stock physical file')
const { balanceFiles, readTimingBaseline } = await import(pathToFileURL(resolve('config/scripts/ci-shard-assignment.mjs')).href)
const { NODE_RUNTIME_INCLUDE } = await import(pathToFileURL(resolve('config/scripts/vitest-node-runtime-files.mjs')).href)
assert.deepStrictEqual(plan.nodeRuntimeIncludes, NODE_RUNTIME_INCLUDE, 'Copied protected-runtime registry differs from the actual stock export')
assert.ok(manifest.fullFiles.includes(plan.measurementFile), 'Full discovery retains the measurement; this one-file diagnostic does not exercise it')
const baseline = readTimingBaseline('unit')
const assignment = { ...balanceFiles(manifest.files, 1, baseline.timings, baseline.overheadMs), baselineSha256: baseline.baselineSha256, sourceSha: plan.sourceSha }
writeFileSync(plan.assignment, JSON.stringify(assignment, null, 2) + '\n')
writeFileSync(plan.fullSelectionPlan, JSON.stringify({ version: 1, sourceSha: plan.sourceSha, files: manifest.fullFiles, executionFiles: manifest.files, reason: 'One unchanged replay CPU attribution file; full discovery remains proven; not a full suite' }, null, 2) + '\n')
plan.ciScope = { runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT, definitionSha: process.env.GITHUB_SHA, actualSourceSha: plan.sourceSha, isolatedRunner: 'ubuntu-24.04-arm', requestedWorkers: 4, shards: 1, purpose: 'observational CPU sampling only; no timing claim' }
writeFileSync(`${proposal}/measurement-plan.json`, JSON.stringify(plan, null, 2) + '\n')

