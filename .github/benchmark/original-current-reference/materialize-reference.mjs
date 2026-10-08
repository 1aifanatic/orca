import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const directory = resolve(import.meta.dirname), root = process.cwd(), count = Number(process.argv[2])
assert.ok([10, 20].includes(count)); assert.equal(process.env.GITHUB_ACTIONS, 'true')
const plan = JSON.parse(readFileSync(resolve(directory, `reference-plan-${count}.json`), 'utf8')), arm = plan.arms.current
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
assert.equal(process.env.BENCH_SOURCE_SHA, arm.sourceSha); assert.equal(arm.shardCount, count)
assert.equal(process.env.RESOURCE_ADMISSION, 'reviewed-staged-20-arm4')
assert.equal(process.versions.node, plan.nodeVersion)
assert.equal(sha(readFileSync(resolve(directory, '../../..', '.github/workflows/ci-pnpm-verification-pilot.yml'))), plan.definitionWorkflowSha256)
for (const [file, expected] of Object.entries(arm.sourceSha256)) assert.equal(sha(readFileSync(resolve(root, file))), expected, `Named source changed: ${file}`)
for (const [file, expected] of Object.entries(plan.payloadSha256)) assert.equal(sha(readFileSync(resolve(directory, file))), expected, `Reviewed payload changed: ${file}`)
const manifest = JSON.parse(readFileSync(resolve(directory, arm.manifest), 'utf8')), golden = JSON.parse(readFileSync(resolve(directory, 'golden-case-manifest.json'), 'utf8'))
assert.equal(sha(readFileSync(resolve(directory, 'golden-case-manifest.json'))), plan.sourceCaseAdmission.goldenSha256)
assert.equal(golden.sourceSha, arm.sourceSha); assert.equal(golden.sourceTree, arm.sourceTree)
assert.equal(golden.physicalFiles, 11715); assert.equal(golden.rawCases, 114039)
assert.deepEqual(golden.rawCaseStates, { passed: 112987, skipped: 1052 })
assert.equal(golden.allThreeOriginalRoundMapsEqual, true); assert.equal(golden.failedWholeReferenceRemainsUnqualified, true)
const { discoverUnitFiles } = await import(pathToFileURL(resolve(root, 'config/scripts/ci-unit-files.mjs')).href)
const actual = discoverUnitFiles(root)
assert.deepEqual(actual, manifest.files); assert.deepEqual(Object.keys(golden.files).sort(), actual)
assert.equal(actual.length, arm.physicalFiles); assert.equal(manifest.sourceSha, arm.sourceSha)
const { balanceFiles, readTimingBaseline } = await import(pathToFileURL(resolve(root, 'config/scripts/ci-shard-assignment.mjs')).href)
const baseline = readTimingBaseline('unit')
assert.equal(baseline.baselineSha256, manifest.baselineSha256)
for (const geometry of [10, 20]) assert.deepEqual(balanceFiles(actual, geometry, baseline.timings, baseline.overheadMs).shards, manifest.assignmentsByCount[String(geometry)])
const assignment = { ...balanceFiles(actual, count, baseline.timings, baseline.overheadMs), baselineSha256: baseline.baselineSha256 }
const { NODE_RUNTIME_INCLUDE } = await import(pathToFileURL(resolve(root, 'config/scripts/vitest-node-runtime-files.mjs')).href)
assert.deepEqual(NODE_RUNTIME_INCLUDE, arm.nodeRuntimeIncludes)
assert.equal(manifest.routes[arm.measurementFile], 'node-measurement')
const output = resolve(root, '.github/benchmark/original-current-reference')
assert.equal(existsSync(output), false, 'Only a fresh owned payload destination')
mkdirSync(output, { recursive: true })
for (const file of Object.keys(plan.payloadSha256)) {
  assert.equal(existsSync(resolve(output, file)), false); copyFileSync(resolve(directory, file), resolve(output, file))
}
copyFileSync(resolve(directory, `reference-plan-${count}.json`), resolve(output, 'reference-plan.json'))
writeFileSync(resolve(output, 'assignment.json'), JSON.stringify(assignment, null, 2) + '\n', { flag: 'wx' })
writeFileSync(resolve(output, 'selection.json'), JSON.stringify({ version: 1, sourceSha: arm.sourceSha, files: actual, executionFiles: actual, mode: 'full', reason: 'Same-source staged10-versus20 complete stock discovery' }, null, 2) + '\n', { flag: 'wx' })
assert.ok(Number.isFinite(Date.parse(process.env.SCALING_RELEASED_AT)))
writeFileSync(resolve(output, 'materialization-proof.json'), JSON.stringify({ geometry: count, releasedAt: process.env.SCALING_RELEASED_AT, arm: 'current', sourceSha: arm.sourceSha, definitionSha: process.env.GITHUB_SHA, runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT, physicalFiles: actual.length, assignmentSha256: sha(readFileSync(resolve(output, 'assignment.json'))), sourceSha256: arm.sourceSha256, payloadSha256: plan.payloadSha256, planSha256: sha(readFileSync(resolve(output, 'reference-plan.json'))), goldenSha256: plan.sourceCaseAdmission.goldenSha256 }, null, 2) + '\n', { flag: 'wx' })
