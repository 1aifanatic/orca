import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const directory = resolve(import.meta.dirname), root = process.cwd()
const plan = JSON.parse(readFileSync(resolve(directory, 'reference-plan.json'), 'utf8'))
const armName = process.argv[2], arm = plan.arms[armName]
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Disposable isolated CI only')
assert.ok(arm); assert.equal(process.env.BENCH_SOURCE_SHA, arm.sourceSha)
assert.equal(process.versions.node, plan.nodeVersion)
assert.equal(sha(readFileSync(resolve(directory, '../../..', '.github/workflows/ci-pnpm-verification-pilot.yml'))), plan.definitionWorkflowSha256)
for (const [file, expected] of Object.entries(arm.sourceSha256)) assert.equal(sha(readFileSync(resolve(root, file))), expected, `Named source changed: ${file}`)
for (const [file, expected] of Object.entries(plan.payloadSha256)) assert.equal(sha(readFileSync(resolve(directory, file))), expected, `Reviewed definition changed: ${file}`)
const admissionPath = resolve(process.env.ORIGINAL_ADMISSION_RESULT)
assert.equal(sha(readFileSync(admissionPath)), plan.originalAdmission.resultSha256, 'Require the exact independently qualified immutable admission result')
const admitted = JSON.parse(readFileSync(admissionPath, 'utf8'))
assert.equal(admitted.qualified, true); assert.deepEqual(admitted.errors, [])
assert.equal(admitted.sourceSha, plan.arms.original.sourceSha)
assert.equal(admitted.definitionSha, plan.originalAdmission.definitionSha)
assert.equal(admitted.runId, plan.originalAdmission.runId); assert.equal(admitted.runAttempt, plan.originalAdmission.runAttempt)
assert.equal(admitted.physicalFiles, plan.arms.original.physicalFiles)
assert.deepEqual(admitted.rawCaseStates, plan.originalAdmission.rawCaseStates)
const manifest = JSON.parse(readFileSync(resolve(directory, arm.manifest), 'utf8'))
const { discoverUnitFiles } = await import(pathToFileURL(resolve(root, 'config/scripts/ci-unit-files.mjs')).href)
const actual = discoverUnitFiles(root)
assert.deepEqual(actual, manifest.files); assert.equal(actual.length, arm.physicalFiles)
assert.equal(manifest.sourceSha, arm.sourceSha)
const { balanceFiles, readTimingBaseline } = await import(pathToFileURL(resolve(root, 'config/scripts/ci-shard-assignment.mjs')).href)
const baseline = readTimingBaseline('unit')
const assignment = { ...balanceFiles(actual, arm.shardCount, baseline.timings, baseline.overheadMs), baselineSha256: baseline.baselineSha256 }
assert.equal(assignment.baselineSha256, manifest.baselineSha256); assert.deepEqual(assignment.shards, manifest.shards)
if (armName === 'current') {
  const { NODE_RUNTIME_INCLUDE } = await import(pathToFileURL(resolve(root, 'config/scripts/vitest-node-runtime-files.mjs')).href)
  assert.deepEqual(NODE_RUNTIME_INCLUDE, arm.nodeRuntimeIncludes)
  assert.equal(manifest.routes[arm.measurementFile], 'node-measurement')
}
const output = resolve(root, '.github/benchmark/original-current-reference')
assert.equal(existsSync(resolve(output, 'materialization-proof.json')), false, 'Never overwrite materialized reference evidence')
mkdirSync(output, { recursive: true })
for (const file of [...Object.keys(plan.payloadSha256), 'reference-plan.json']) copyFileSync(resolve(directory, file), resolve(output, file))
writeFileSync(resolve(output, 'assignment.json'), JSON.stringify(assignment, null, 2) + '\n', { flag: 'wx' })
writeFileSync(resolve(output, 'selection.json'), JSON.stringify({ version: 1, sourceSha: arm.sourceSha, files: actual, executionFiles: actual, mode: 'full', reason: 'Complete named original/current reference; every stock physical file retained' }, null, 2) + '\n', { flag: 'wx' })
writeFileSync(resolve(output, 'materialization-proof.json'), JSON.stringify({ arm: armName, sourceSha: arm.sourceSha, definitionSha: process.env.GITHUB_SHA, runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT, physicalFiles: actual.length, assignmentSha256: sha(readFileSync(resolve(output, 'assignment.json'))), sourceSha256: arm.sourceSha256, payloadSha256: plan.payloadSha256, originalAdmissionResultSha256: plan.originalAdmission.resultSha256 }, null, 2) + '\n', { flag: 'wx' })
