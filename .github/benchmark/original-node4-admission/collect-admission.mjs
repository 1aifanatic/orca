import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { globSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname, relative } from 'node:path'
import { pathToFileURL } from 'node:url'

const directory = resolve(import.meta.dirname)
const plan = JSON.parse(readFileSync(resolve(directory, 'admission-plan.json'), 'utf8'))
assert.equal(createHash('sha256').update(readFileSync(resolve(directory, '../../..', '.github/workflows/ci-pnpm-verification-pilot.yml'))).digest('hex'), plan.definitionWorkflowSha256)
const root = resolve(process.argv[2] ?? 'original-admission-artifacts')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
assert.equal(globSync('original-node4-admission-result.json', { cwd: process.cwd() }).length, 0, 'Never replace a retained aggregate admission result')
const result = { qualified: false, classification: 'Original-source correctness/resource admission only', sourceSha: plan.sourceSha, definitionSha: process.env.GITHUB_SHA, runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT, errors: [] }
try {
  const summaries = globSync('**/original-shard-*-summary.json', { cwd: root }).sort()
  assert.equal(summaries.length, 5, 'Every original stock shard must finish normally and upload evidence')
  const rows = summaries.map(path => ({ path: resolve(root, path), summary: JSON.parse(readFileSync(resolve(root, path), 'utf8')) }))
  const manifest = JSON.parse(readFileSync(resolve(directory, 'original-manifest.json'), 'utf8'))
  const sourceRoot = resolve(directory, '../../..')
  for (const file of ['config/scripts/ci-shard-assignment.mjs', 'config/scripts/ci-shard-timings.json']) assert.equal(sha(readFileSync(resolve(sourceRoot, file))), plan.sourceSha256[file])
  const { balanceFiles, readTimingBaseline } = await import(pathToFileURL(resolve(sourceRoot, 'config/scripts/ci-shard-assignment.mjs')).href)
  const baseline = readTimingBaseline('unit')
  const expectedAssignment = balanceFiles(manifest.files, 5, baseline.timings, baseline.overheadMs)
  const states = {}, caseStates = {}, allFiles = [], allCases = [], sourceHashes = []
  let signature
  const observedShards = new Set()
  for (const { path, summary: row } of rows) {
    assert.equal(row.qualified, true); assert.deepEqual(row.errors, [])
    assert.equal(row.sourceSha, plan.sourceSha)
    assert.equal(row.result.code, 0); assert.equal(row.result.signal, null); assert.ok(!row.launchError)
    assert.equal(row.lifecycleError, false); assert.deepEqual(row.lingeringCoordinators, [])
    assert.ok(Array.isArray(row.samples) && row.samples.length >= 2 && row.samples.every(sample => !sample.error && sample.noiseGuardAvailable === true && sample.coordinators.every(process => process.owned === true)))
    assert.deepEqual(row.samples.at(-1).coordinators, [])
    assert.equal(row.host.definitionSha, process.env.GITHUB_SHA)
    assert.equal(row.host.runId, process.env.GITHUB_RUN_ID)
    assert.equal(row.host.runAttempt, process.env.GITHUB_RUN_ATTEMPT)
    assert.equal(row.host.nodeVersion, plan.nodeVersion)
    assert.equal(row.host.platform, 'linux'); assert.equal(row.host.arch, 'arm64'); assert.equal(row.host.logicalCpus, 4)
    assert.deepEqual(row.before, row.after)
    assert.deepEqual(row.before.sources, plan.sourceSha256)
    assert.deepEqual(row.payloadSha256, plan.payloadSha256)
    assert.equal(row.planSha256, sha(readFileSync(resolve(directory, 'admission-plan.json'))))
    const shard = row.actualAssignment.selectedShard
    assert.ok(Number.isInteger(shard) && shard >= 1 && shard <= 5 && !observedShards.has(shard)); observedShards.add(shard)
    assert.equal(row.actualAssignment.sourceSha, plan.sourceSha)
    assert.equal(row.actualAssignment.runId, process.env.GITHUB_RUN_ID)
    assert.equal(row.actualAssignment.runAttempt, process.env.GITHUB_RUN_ATTEMPT)
    assert.equal(row.actualAssignment.baselineSha256, baseline.baselineSha256)
    assert.deepEqual(row.actualAssignment.shards, expectedAssignment.shards)
    const ownFiles = row.actualAssignment.shards[shard - 1].files
    assert.deepEqual([...row.files].sort(), [...ownFiles].sort())
    assert.deepEqual(row.actualAssignment.shards.flatMap(shard => shard.files).sort(), manifest.files)
    const artifactDirectory = dirname(path)
    for (const [file, expected] of Object.entries(plan.payloadSha256)) assert.equal(sha(readFileSync(resolve(artifactDirectory, file))), expected, `Uploaded definition changed: ${file}`)
    assert.equal(sha(readFileSync(resolve(artifactDirectory, 'admission-plan.json'))), row.planSha256)
    const prefix = path.replace(/-summary\.json$/, '')
    assert.equal(sha(readFileSync(prefix + '-resources.jsonl')), row.resourceSha256)
    const resources = readFileSync(prefix + '-resources.jsonl', 'utf8').trim().split('\n').map(line => JSON.parse(line))
    assert.ok(resources.length >= 2)
    const preflight = JSON.parse(readFileSync(prefix + '-resource-preflight.json', 'utf8'))
    assert.equal(preflight.qualified, true); assert.deepEqual(preflight.binding, row.cgroupBinding)
    const counters = record => Object.fromEntries(['oom', 'oom_kill'].map(key => {
      const value = record.cgroupEvents?.match(new RegExp(`^${key} (\\d+)$`, 'm'))?.[1]
      assert.ok(value !== undefined); return [key, value]
    }))
    const initial = counters(resources[0])
    for (const record of resources) {
      assert.deepEqual(record.binding, row.cgroupBinding); assert.deepEqual(record.eventCounters, counters(record)); assert.deepEqual(record.eventCounters, initial)
      assert.match(record.cgroupCurrent, /^\d+$/)
    }
    const report = JSON.parse(readFileSync(prefix + '.json', 'utf8'))
    const details = JSON.parse(readFileSync(prefix + '-details.json', 'utf8'))
    const timing = JSON.parse(readFileSync(prefix + '-timings.json', 'utf8'))
    assert.ok(report.success && report.numFailedTests === 0)
    const actualFiles = report.testResults.map(module => relative(row.sourceRoot, module.name).replaceAll('\\', '/')).sort()
    assert.deepEqual(actualFiles, [...ownFiles].sort()); assert.equal(new Set(actualFiles).size, ownFiles.length)
    const rawCases = report.testResults.flatMap(module => module.assertionResults.map((test, assertionIndex) => ({ assertionIndex, file: relative(row.sourceRoot, module.name).replaceAll('\\', '/'), fullName: test.fullName, title: test.title, ancestorTitles: test.ancestorTitles, status: test.status })))
    assert.deepEqual(rawCases, row.rawCases); assert.equal(rawCases.length, report.numTotalTests)
    assert.equal(details.reason, 'passed'); assert.deepEqual(details.errors, [])
    assert.deepEqual(details, row.details)
    assert.equal(details.modules.length, ownFiles.length); assert.deepEqual(details.modules.map(module => module.file).sort(), [...ownFiles].sort())
    assert.ok(details.modules.every(module => module.pool === 'forks' && ['passed', 'skipped'].includes(module.state) && details.projects.some(project => project.name === module.project && project.pool === 'forks')))
    assert.deepEqual(Object.keys(timing.results).sort(), [...ownFiles].sort())
    assert.equal(timing.status, 'passed'); assert.equal(timing.unhandledErrors, 0)
    assert.equal(timing.nodeVersion, plan.nodeVersion); assert.equal(timing.sourceSha, plan.sourceSha); assert.equal(timing.runId, process.env.GITHUB_RUN_ID); assert.equal(timing.runAttempt, process.env.GITHUB_RUN_ATTEMPT); assert.deepEqual(timing.shard, { index: shard, count: 5 })
    const originalArgv = ['exec', 'vitest', 'run', '--config', 'config/vitest.config.ts', `--shard=${shard}/5`, '--maxWorkers=4', '--reporter=default', '--reporter=json', '--reporter=./config/scripts/ci-unit-timing-reporter.mjs', '--reporter=./.github/benchmark/original-node4-admission/admission-reporter.mjs', `--outputFile=${resolve(row.sourceRoot, '.github/benchmark/original-node4-admission', `original-shard-${shard}.json`)}`]
    assert.deepEqual(row.argv, originalArgv)
    assert.ok(!/Timeout terminating|failed to terminate.*worker|worker.*termination.*timed out|Unhandled Errors/i.test(readFileSync(prefix + '.log', 'utf8')))
    for (const state of Object.values(timing.results)) { assert.ok(['passed', 'skipped'].includes(state)); states[state] = (states[state] ?? 0) + 1 }
    for (const row of rawCases) { assert.ok(['passed', 'pending', 'todo', 'skipped'].includes(row.status)); caseStates[row.status] = (caseStates[row.status] ?? 0) + 1 }
    const current = { rootIsolation: details.rootIsolation, resolvedRootMaxWorkers: details.resolvedRootMaxWorkers, experimentalFsModuleCache: details.experimentalFsModuleCache, projects: details.projects }
    assert.equal(current.rootIsolation, true); assert.equal(current.resolvedRootMaxWorkers, 4); assert.equal(current.experimentalFsModuleCache, false)
    assert.equal(current.projects.length, 1)
    for (const project of current.projects) {
      assert.equal(project.pool, 'forks'); assert.equal(project.effectiveMaxWorkers, 4); assert.equal(project.isolate, true); assert.equal(project.experimentalFsModuleCache, false)
      assert.equal(project.testTimeout, 30000); assert.equal(project.hookTimeout, 60000); assert.deepEqual(project.execArgv, plan.execArgv); assert.deepEqual(project.setups, plan.setupFiles)
    }
    if (signature) assert.deepEqual(current, signature, 'Original project/setup/flags differ between shards')
    else signature = current
    allFiles.push(...ownFiles); allCases.push(...rawCases)
    sourceHashes.push({ shard, summarySha256: sha(readFileSync(path)), reportSha256: sha(readFileSync(prefix + '.json')), detailsSha256: sha(readFileSync(prefix + '-details.json')), timingSha256: sha(readFileSync(prefix + '-timings.json')) })
  }
  assert.deepEqual(allFiles.sort(), manifest.files); assert.equal(new Set(allFiles).size, plan.physicalFiles)
  result.physicalFiles = allFiles.length; result.fileStates = states; result.rawCaseStates = caseStates; result.rawCases = allCases; result.sourceHashes = sourceHashes; result.resolvedProjectSignature = signature
  result.limit = 'One original-source pass provides resource/correctness admission, not reproducibility, historical542s provenance, timing improvement, current-case parity or complete nonunit/shell gates. All natural raw titles/ordinals retained with zero title normalization.'
  result.qualified = true
} catch (error) { result.qualified = false; result.errors.push(String(error)); process.exitCode = 1 }
writeFileSync('original-node4-admission-result.json', JSON.stringify(result, null, 2) + '\n', { flag: 'wx' })
console.log(JSON.stringify({ qualified: result.qualified, physicalFiles: result.physicalFiles, rawCaseStates: result.rawCaseStates, errors: result.errors }))
