import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const directory = resolve(import.meta.dirname)
const plan = JSON.parse(readFileSync(resolve(directory, 'admission-plan.json'), 'utf8'))
const root = process.cwd()
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Isolated CI only')
assert.equal(process.env.BENCH_SOURCE_SHA, plan.sourceSha)
assert.equal(sha(readFileSync(resolve(directory, '../../..', '.github/workflows/ci-pnpm-verification-pilot.yml'))), plan.definitionWorkflowSha256, 'Actual registered definition workflow changed')
for (const [file, hash] of Object.entries(plan.sourceSha256)) {
  assert.equal(sha(readFileSync(resolve(root, file))), hash, `Original source changed: ${file}`)
}
for (const [file, hash] of Object.entries(plan.payloadSha256)) {
  assert.equal(sha(readFileSync(resolve(directory, file))), hash, `Definition payload changed: ${file}`)
}
const filesModule = await import(pathToFileURL(resolve(root, 'config/scripts/ci-unit-files.mjs')).href)
const actual = filesModule.discoverUnitFiles(root)
const manifest = JSON.parse(readFileSync(resolve(directory, 'original-manifest.json'), 'utf8'))
assert.deepEqual(actual, manifest.files, 'Fresh original canonical discovery must exactly match the original11117 manifest')
assert.equal(actual.length, plan.physicalFiles)
const assignmentModule = await import(pathToFileURL(resolve(root, 'config/scripts/ci-shard-assignment.mjs')).href)
const baseline = assignmentModule.readTimingBaseline('unit')
const assignment = { ...assignmentModule.balanceFiles(actual, 5, baseline.timings, baseline.overheadMs), baselineSha256: baseline.baselineSha256 }
const output = resolve(root, '.github/benchmark/original-node4-admission')
mkdirSync(output, { recursive: true })
for (const file of [...Object.keys(plan.payloadSha256), 'admission-plan.json']) copyFileSync(resolve(directory, file), resolve(output, file))
writeFileSync(resolve(output, 'assignment.json'), JSON.stringify(assignment, null, 2) + '\n')
writeFileSync(resolve(output, 'selection.json'), JSON.stringify({ version: 1, sourceSha: plan.sourceSha, files: actual, executionFiles: actual, mode: 'full', reason: 'Original complete source correctness/resource admission' }, null, 2) + '\n')
writeFileSync(resolve(output, 'materialization-proof.json'), JSON.stringify({ sourceSha: plan.sourceSha, definitionSha: process.env.GITHUB_SHA, runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT, physicalFiles: actual.length, originalConfigSha256: plan.sourceSha256['config/vitest.config.ts'], originalLockSha256: plan.sourceSha256['pnpm-lock.yaml'], assignmentSha256: sha(readFileSync(resolve(output, 'assignment.json'))), sourceSha256: plan.sourceSha256, payloadSha256: plan.payloadSha256 }, null, 2) + '\n')
