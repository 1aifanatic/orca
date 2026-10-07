import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

assert.equal(process.env.GITHUB_ACTIONS, 'true')
assert.match(process.env.BENCH_SOURCE_SHA ?? '', /^[a-f0-9]{40}$/)
const payload = resolve(import.meta.dirname, 'payload')
const directory = 'notes/bun-migration/performance'
const proposal = `${directory}/ci-ten-shard-pilot`
mkdirSync(proposal, { recursive: true })
const plan = JSON.parse(readFileSync(resolve(payload, 'measurement-plan.json'), 'utf8'))
assert.equal(plan.sourceSha, process.env.BENCH_SOURCE_SHA)
const { runProcessSync } = await import(pathToFileURL(resolve('config/scripts/script-child-process.mjs')).href)
const sourceHead = runProcessSync({ program: 'git', args: ['rev-parse', 'HEAD'], timeoutMs: 5000, maxOutputBytes: 65536 })
assert.equal(sourceHead.code, 0)
assert.equal(sourceHead.outputTruncated, false)
assert.equal(sourceHead.stdout.trim(), plan.sourceSha)
assert.equal(process.versions.node, plan.nodeVersion)
const hash = value => createHash('sha256').update(value).digest('hex')
assert.deepStrictEqual(Object.keys(plan.payloadSha256).sort(), ['benchmark-matched-shard.mjs', 'canonical-case-identities.mjs', 'current-main-manifest.json', 'persistence-import-reuse-benchmark-reporter.mjs'])
for (const [name, expected] of Object.entries(plan.payloadSha256)) {
  assert.equal(hash(readFileSync(resolve(payload, name))), expected, `Reviewed payload changed: ${name}`)
}
for (const [name, expected] of Object.entries(plan.sourceSha256)) {
  assert.equal(hash(readFileSync(name)), expected, `Frozen source changed: ${name}`)
}
copyFileSync(resolve(payload, 'benchmark-matched-shard.mjs'), `${proposal}/benchmark-matched-shard.mjs`)
copyFileSync(resolve(payload, 'canonical-case-identities.mjs'), `${proposal}/canonical-case-identities.mjs`)
copyFileSync(resolve(payload, 'persistence-import-reuse-benchmark-reporter.mjs'), `${directory}/persistence-import-reuse-benchmark-reporter.mjs`)
copyFileSync(resolve(payload, 'current-main-manifest.json'), `${proposal}/current-main-manifest.json`)
const manifest = JSON.parse(readFileSync(`${proposal}/current-main-manifest.json`, 'utf8'))
assert.equal(manifest.sourceSha, plan.sourceSha)
assert.equal(manifest.files.length, plan.physicalFiles)
const { UNIT_INCLUDE, UNIT_EXCLUDE, discoverUnitFiles } = await import(pathToFileURL(resolve('config/scripts/ci-unit-files.mjs')).href)
assert.deepStrictEqual(manifest.includes, UNIT_INCLUDE, 'Manifest include patterns differ from the actual stock export')
assert.deepStrictEqual(manifest.excludes, UNIT_EXCLUDE, 'Manifest exclusions differ from the actual stock export')
assert.deepStrictEqual(manifest.files, discoverUnitFiles(), 'Frozen discovery must retain every actual stock physical file')
const { balanceFiles, readTimingBaseline } = await import(pathToFileURL(resolve('config/scripts/ci-shard-assignment.mjs')).href)
const { NODE_RUNTIME_INCLUDE } = await import(pathToFileURL(resolve('config/scripts/vitest-node-runtime-files.mjs')).href)
assert.deepStrictEqual(plan.nodeRuntimeIncludes, NODE_RUNTIME_INCLUDE, 'Copied protected-runtime registry differs from the actual stock export')
assert.ok(manifest.files.includes(plan.measurementFile), 'Keep the actual event-loop measurement enrolled')
const baseline = readTimingBaseline('unit')
const assignment = { ...balanceFiles(manifest.files, 10, baseline.timings, baseline.overheadMs), baselineSha256: baseline.baselineSha256, sourceSha: plan.sourceSha }
writeFileSync(plan.assignment, JSON.stringify(assignment, null, 2) + '\n')
writeFileSync(plan.fullSelectionPlan, JSON.stringify({ version: 1, sourceSha: plan.sourceSha, files: manifest.files, executionFiles: manifest.files, reason: 'Complete frozen matched benchmark; no test selection or omission' }, null, 2) + '\n')
plan.ciScope = { runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT, definitionSha: process.env.GITHUB_SHA, actualSourceSha: plan.sourceSha, isolatedRunner: 'ubuntu-24.04-arm', requestedWorkers: 4, shards: 10 }
writeFileSync(`${proposal}/measurement-plan.json`, JSON.stringify(plan, null, 2) + '\n')
