import assert from 'node:assert/strict'
import { canonicalCases } from './payload/canonical-case-identities.mjs'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, join, matchesGlob, relative, resolve } from 'node:path'

const directory = resolve(process.argv[2] ?? 'matched-artifacts')
const output = resolve('matched-pipeline-result.json')
const result = {
  qualified: false,
  sourceSha: process.env.EXPECTED_SOURCE_SHA,
  definitionSha: process.env.EXPECTED_DEFINITION_SHA,
  runId: process.env.EXPECTED_RUN_ID,
  runAttempt: process.env.EXPECTED_RUN_ATTEMPT,
  samples: [], pairs: [], errors: [],
  scope: 'Current frozen full workload, matched Node versus Bun+protected Node, five ARM4 shards. Critical maximum is a command-wall proxy without a cross-host phase barrier; not synchronized pipeline latency. No historical542s causal claim.'
}
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const load = path => JSON.parse(readFileSync(path, 'utf8'))
const walk = path => readdirSync(path, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(join(path, entry.name)) : [join(path, entry.name)])
const uniqueFile = (paths, name) => {
  const found = paths.filter(path => basename(path) === name)
  assert.equal(found.length, 1, `Require exactly one ${name}`)
  return found[0]
}
const sorted = values => [...values].sort()
const sameFiles = (actual, expected, message) => {
  assert.equal(new Set(actual).size, actual.length, `${message}: duplicate physical file`)
  assert.deepStrictEqual(sorted(actual), sorted(expected), message)
}
const caseDigest = cases => hash(JSON.stringify([...cases].sort((a, b) => a.file.localeCompare(b.file) || a.fullName.localeCompare(b.fullName))))
const ordinaryOptions = signature => signature.projects.map(({ name, pool, ...options }) => ({ name, pool, options }))
const allGateNames = ['performanceQualified', 'qualified', 'caseParity', 'assignmentParity', 'projectSignatureParity', 'filesEqual', 'cacheEnabled', 'setupPreserved', 'routePreserved', 'isolationPreserved', 'workerCapPreserved', 'sourceUnchanged', 'noiseGuardAvailable']

try {
  for (const value of [result.sourceSha, result.definitionSha]) assert.match(value ?? '', /^[a-f0-9]{40}$/)
  for (const value of [result.runId, result.runAttempt]) assert.match(value ?? '', /^\d+$/)
  let commonManifest, commonPlan, commonAssignment, commonPayloadFingerprint, commonRuntime
  const byArmRound = new Map()
  for (let shard = 1; shard <= 5; shard++) {
    const paths = walk(join(directory, `matched-pipeline-shard-${shard}`))
    const planPath = uniqueFile(paths, 'measurement-plan.json')
    const manifestPath = uniqueFile(paths, 'current-main-manifest.json')
    const assignmentPath = uniqueFile(paths, 'expected-assignment.json')
    const selectionPath = uniqueFile(paths, 'full-selection.json')
    const plan = load(planPath), manifest = load(manifestPath), expected = load(assignmentPath), selection = load(selectionPath)
    assert.equal(hash(readFileSync(new URL('./payload/canonical-case-identities.mjs', import.meta.url))), plan.payloadSha256['canonical-case-identities.mjs'], 'Bind the actually imported canonicalization module to the reviewed payload')
    assert.equal(plan.sourceSha, result.sourceSha)
    assert.equal(manifest.sourceSha, result.sourceSha)
    assert.equal(manifest.files.length, plan.physicalFiles)
    assert.equal(plan.shards, 5); assert.equal(plan.maxWorkers, 4)
    assert.equal(plan.cache.warmRuns, 2)
    assert.equal(plan.ciScope.actualSourceSha, result.sourceSha)
    assert.equal(plan.ciScope.definitionSha, result.definitionSha)
    assert.equal(plan.ciScope.runId, result.runId)
    assert.equal(plan.ciScope.runAttempt, result.runAttempt)
    assert.equal(plan.ciScope.requestedWorkers, 4); assert.equal(plan.ciScope.shards, 5)
    assert.equal(expected.sourceSha, result.sourceSha); assert.equal(expected.shards.length, 5)
    sameFiles(expected.shards.flatMap(part => part.files), manifest.files, 'All five stock LPT assignments must cover the full manifest exactly once')
    assert.equal(selection.version, 1); assert.equal(selection.sourceSha, result.sourceSha)
    sameFiles(selection.files, manifest.files, 'Complete selection discovery differs')
    sameFiles(selection.executionFiles, manifest.files, 'Complete selection must retain every file')
    if (commonManifest) {
      assert.deepStrictEqual(manifest, commonManifest)
      assert.deepStrictEqual(plan, commonPlan)
      assert.deepStrictEqual(expected, commonAssignment)
    } else { commonManifest = manifest; commonPlan = plan; commonAssignment = expected }
    const summaries = []
    for (const arm of ['node', 'bun']) for (let round = 0; round < 3; round++) {
      const label = `${plan.label}-shard-${shard}-${arm}-${round}`
      const row = load(uniqueFile(paths, `${label}-summary.json`))
      const actualAssignment = load(uniqueFile(paths, `${label}-assignment.json`))
      const detailsBytes = readFileSync(uniqueFile(paths, `${label}-details.json`))
      const details = JSON.parse(detailsBytes)
      const report = load(uniqueFile(paths, `${label}.json`))
      assert.equal(row.arm, arm); assert.equal(row.shard, shard); assert.equal(row.round, round)
      assert.equal(row.phase, round === 0 ? 'cold' : 'warm')
      assert.deepStrictEqual(row.ciScope, plan.ciScope)
      assert.equal(row.manifestSha256, hash(readFileSync(manifestPath)))
      assert.equal(row.casePlanSha256, hash(readFileSync(planPath)))
      assert.equal(row.expectedAssignmentSha256, hash(readFileSync(assignmentPath)))
      assert.equal(row.fullSelectionSha256, hash(readFileSync(selectionPath)))
      for (const gate of allGateNames) assert.equal(row[gate], true, `${label}: ${gate} failed`)
      assert.equal(row.external, false); assert.equal(row.lifecycleError, false)
      assert.deepStrictEqual(row.lingeringCoordinators, []); assert.equal(row.result.code, 0)
      assert.equal(row.result.signal, null); assert.equal(row.launchError, undefined)
      assert.ok(Number.isFinite(row.seconds) && row.seconds > 0)
      assert.equal(row.host.platform, 'linux'); assert.equal(row.host.arch, 'arm64')
      assert.equal(row.host.logicalCpus, 4, 'Runner class must match the explicitly requested ARM4 scope')
      assert.equal(row.host.nodeVersion, plan.nodeVersion)
      assert.ok(row.host.bunRevision.startsWith(`${plan.bunVersion}+`))
      assert.equal(row.host.vitestVersion, plan.vitestVersion)
      const runtime = { platform: row.host.platform, arch: row.host.arch, logicalCpus: row.host.logicalCpus, nodeVersion: row.host.nodeVersion, nodeExecutable: row.host.nodeExecutable, bunRevision: row.host.bunRevision, vitestVersion: row.host.vitestVersion }
      if (commonRuntime) assert.deepStrictEqual(runtime, commonRuntime, 'All five held runners must use the same actual runtime revisions and ARM4 class')
      else commonRuntime = runtime
      assert.equal(row.before.head, result.sourceSha); assert.deepStrictEqual(row.before, row.after)
      assert.equal(row.before.diffSha256, hash(''))
      assert.equal(row.before.planSha256, hash(readFileSync(planPath)))
      assert.equal(row.before.configSha256, plan.sourceSha256['config/vitest.config.ts'])
      assert.equal(row.before.harnessSha256, plan.payloadSha256['benchmark-matched-shard.mjs'])
      assert.equal(row.before.reporterSha256, plan.payloadSha256['persistence-import-reuse-benchmark-reporter.mjs'])
      assert.equal(hash(readFileSync(manifestPath)), plan.payloadSha256['current-main-manifest.json'])
      const fingerprint = { config: row.before.configSha256, reporter: row.before.reporterSha256, harness: row.before.harnessSha256, plan: row.before.planSha256 }
      if (commonPayloadFingerprint) assert.deepStrictEqual(fingerprint, commonPayloadFingerprint)
      else commonPayloadFingerprint = fingerprint
      assert.equal(actualAssignment.sourceSha, result.sourceSha)
      assert.equal(String(actualAssignment.runId), result.runId)
      assert.equal(String(actualAssignment.runAttempt), result.runAttempt)
      assert.equal(actualAssignment.selectedShard, shard)
      assert.equal(actualAssignment.baselineSha256, expected.baselineSha256)
      assert.deepStrictEqual(actualAssignment.shards, expected.shards)
      assert.equal(report.success, true); assert.equal(report.numFailedTests, 0)
      assert.equal(report.numTotalTests, row.identities.length)
      assert.equal(row.rawIdentities.length, row.identities.length)
      const reportCases = report.testResults.flatMap(module => module.assertionResults.map(test => ({ file: relative(row.sourceRoot, module.name).replaceAll('\\', '/'), fullName: test.fullName, status: test.status, title: test.title, ancestorTitles: test.ancestorTitles })))
      assert.deepStrictEqual(row.rawIdentities, reportCases, 'Raw case maps must remain byte-equivalent to the actual reporter assertions')
      assert.deepStrictEqual(row.identities, canonicalCases(reportCases, expected.shards[shard - 1].files), 'Only the frozen source-qualified generated title components may differ')
      assert.equal(hash(readFileSync(uniqueFile(paths, 'canonical-case-identities.mjs'))), plan.payloadSha256['canonical-case-identities.mjs'])
      assert.deepStrictEqual(row.details, details)
      assert.deepStrictEqual(details.errors, [])
      sameFiles(details.modules.map(module => module.file), expected.shards[shard - 1].files, `${label}: reported physical files differ`)
      const routes = details.modules.map(({ diagnostic, ...route }) => route).sort((a, b) => a.file.localeCompare(b.file))
      const expectedRoutes = expected.shards[shard - 1].files.map(file => ({ file,
        project: file === plan.measurementFile ? 'node-measurement' : arm === 'node' ? 'node' : plan.nodeRuntimeIncludes.some(pattern => matchesGlob(file, pattern)) ? 'node-runtime' : 'bun',
        pool: arm === 'node' ? 'forks' : file === plan.measurementFile || plan.nodeRuntimeIncludes.some(pattern => matchesGlob(file, pattern)) ? 'node-runtime' : 'forks'
      })).sort((a, b) => a.file.localeCompare(b.file))
      assert.deepStrictEqual(routes, expectedRoutes, `${label}: protect actual Node routes and measurement ownership`)
      const counts = row.identities.reduce((totals, test) => {
        assert.ok(expected.shards[shard - 1].files.includes(test.file))
        totals[test.status] = (totals[test.status] ?? 0) + 1
        return totals
      }, {})
      assert.equal(counts.failed ?? 0, 0)
      const sample = { arm, round, shard, phase: row.phase, seconds: row.seconds,
        files: details.modules.map(module => module.file), cases: row.identities.length, statuses: counts,
        normalizedCaseMapSha256: caseDigest(row.identities), rawCaseMapSha256: caseDigest(row.rawIdentities),
        host: row.host, callerEnv: row.callerEnv, callerRuntimeEnvSha256: row.callerRuntimeEnvSha256,
        signature: row.resolvedProjectSignature, nodeWorkerIdentity: row.expectedNodeWorkerIdentity,
        startedAt: row.startedAt, finishedAt: row.finishedAt, artifact: `${label}-summary.json` }
      summaries.push(sample); result.samples.push(sample)
      const key = `${arm}-${round}`
      if (!byArmRound.has(key)) byArmRound.set(key, [])
      byArmRound.get(key).push(sample)
    }
    const baseline = summaries.find(row => row.arm === 'node' && row.round === 0)
    for (const sample of summaries) {
      assert.deepStrictEqual(sample.host, baseline.host, `Shard${shard}: same held host and runtime versions across all six commands`)
      assert.deepStrictEqual(sample.callerEnv, baseline.callerEnv)
      assert.equal(sample.callerRuntimeEnvSha256, baseline.callerRuntimeEnvSha256)
      assert.equal(sample.normalizedCaseMapSha256, baseline.normalizedCaseMapSha256, `Shard${shard}: no runtime-dependent registration/status differences`)
      assert.deepStrictEqual(sample.statuses, baseline.statuses)
      const armBaseline = summaries.find(row => row.arm === sample.arm && row.round === 0)
      assert.deepStrictEqual(sample.signature, armBaseline.signature)
      const node = ordinaryOptions(baseline.signature)
      const reference = node.find(project => project.name === 'node').options
      assert.deepStrictEqual(node.find(project => project.name === 'node-measurement').options, reference)
      const projects = ordinaryOptions(sample.signature)
      assert.deepStrictEqual(sorted(projects.map(project => project.name)), sample.arm === 'node' ? ['node', 'node-measurement'] : ['bun', 'node-measurement', 'node-runtime'])
      for (const project of projects) {
        assert.equal(project.pool, sample.arm === 'node' || project.name === 'bun' ? 'forks' : 'node-runtime')
        assert.deepStrictEqual(project.options, reference, `Shard${shard}: exact setup order, native flags, timeouts, isolation and cache must match across stock runtime projects`)
      }
      assert.equal(sample.signature.rootFsModuleCache, true)
      assert.equal(sample.signature.rootIsolation, true)
      assert.equal(sample.signature.resolvedRootMaxWorkers, 4)
    }
    const order = summaries.slice().sort((a, b) => a.startedAt.localeCompare(b.startedAt)).map(row => `${row.arm}-${row.round}`)
    assert.deepStrictEqual(order, ['node-0', 'bun-0', 'bun-1', 'node-1', 'node-2', 'bun-2'], 'Count all commands in the reviewed alternating order')
    const chronological = summaries.slice().sort((a, b) => a.startedAt.localeCompare(b.startedAt))
    for (let index = 1; index < chronological.length; index++) assert.ok(chronological[index - 1].finishedAt <= chronological[index].startedAt, 'No commands overlap within the held shard job')
  }
  for (const samples of byArmRound.values()) {
    assert.equal(samples.length, 5)
    sameFiles(samples.flatMap(sample => sample.files), commonManifest.files, 'Each complete runtime/round union must retain every physical file exactly once')
  }
  for (let round = 0; round < 3; round++) {
    const node = byArmRound.get(`node-${round}`), bun = byArmRound.get(`bun-${round}`)
    const nodeMax = Math.max(...node.map(row => row.seconds)), bunMax = Math.max(...bun.map(row => row.seconds))
    const sum = values => values.reduce((total, row) => total + row.seconds, 0)
    result.pairs.push({ round, cache: round === 0 ? 'both cold; counted' : 'both warm; counted', order: commonPlan.rounds[round].order,
      nodeCriticalMaxSeconds: nodeMax, bunCriticalMaxSeconds: bunMax, criticalMaxRatio: nodeMax / bunMax,
      nodeAggregateSeconds: sum(node), bunAggregateSeconds: sum(bun), aggregateRatio: sum(node) / sum(bun),
      perShard: node.map(control => ({ shard: control.shard, nodeSeconds: control.seconds,
        bunSeconds: bun.find(candidate => candidate.shard === control.shard).seconds,
        ratio: control.seconds / bun.find(candidate => candidate.shard === control.shard).seconds })) })
  }
  result.runtime = commonRuntime
  result.physicalFiles = commonManifest.files.length
  result.totalCases = byArmRound.get('node-0').reduce((total, row) => total + row.cases, 0)
  result.totalStatuses = byArmRound.get('node-0').reduce((total, row) => {
    for (const [status, count] of Object.entries(row.statuses)) total[status] = (total[status] ?? 0) + count
    return total
  }, {})
  result.nodeMeanCriticalMaxSeconds = result.pairs.reduce((sum, pair) => sum + pair.nodeCriticalMaxSeconds, 0) / 3
  result.bunMeanCriticalMaxSeconds = result.pairs.reduce((sum, pair) => sum + pair.bunCriticalMaxSeconds, 0) / 3
  result.meanCriticalMaxRatio = result.nodeMeanCriticalMaxSeconds / result.bunMeanCriticalMaxSeconds
  result.qualified = true
  result.currentSourceRuntimeTwoTimes = result.pairs.every(pair => pair.criticalMaxRatio >= 2) && result.meanCriticalMaxRatio >= 2
  result.historicalOriginalGoalQualified = false
} catch (error) {
  result.errors.push(String(error.stack ?? error))
  process.exitCode = 1
} finally {
  writeFileSync(output, JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify({ qualified: result.qualified, physicalFiles: result.physicalFiles, totalCases: result.totalCases,
    currentSourceRuntimeTwoTimes: result.currentSourceRuntimeTwoTimes, errors: result.errors }))
}
