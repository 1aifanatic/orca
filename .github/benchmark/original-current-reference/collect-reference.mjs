import assert from 'node:assert/strict'
import { existsSync, globSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { inspect } from 'node:util'
import { canonicalOrdinals, sha, validateReferenceSample } from './reference-sample-contract.mjs'

const directory = resolve(import.meta.dirname), root = resolve(process.argv[2] ?? 'reference-artifacts')
const plan = JSON.parse(readFileSync(resolve(directory, 'reference-plan.json'), 'utf8'))
assert.equal(sha(readFileSync(resolve(directory, '../../..', '.github/workflows/ci-pnpm-verification-pilot.yml'))), plan.definitionWorkflowSha256)
for (const [file, expected] of Object.entries(plan.payloadSha256)) assert.equal(sha(readFileSync(resolve(directory, file))), expected)
const output = 'original-current-reference-result.json'
assert.equal(existsSync(output), false, 'Never replace a retained reference attempt')
const result = { qualified: false, errors: [], classification: 'Known complete original/current revisions, different workloads and doubled nominal allocation; no recovered historical542-second provenance or causal-only claim', runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT, definitionSha: process.env.GITHUB_SHA, samples: [], admissionResultSha256: plan.originalAdmission.resultSha256 }
try {
  assert.equal(typeof plan.originalAdmission.resultSha256, 'string'); assert.match(plan.originalAdmission.resultSha256, /^[0-9a-f]{64}$/)
  const paths = globSync('**/*-shard-*-round-*-summary.json', { cwd: root }).sort()
  assert.equal(paths.length, 45, 'All45 counted commands must finish and preserve raw evidence')
  const indexed = new Map()
  for (const file of paths) {
    const match = file.match(/(?:^|\/)(original|current)-shard-(\d+)-round-([012])-summary\.json$/)
    assert.ok(match); const key = `${match[1]}:${Number(match[2])}:${Number(match[3])}`
    assert.equal(indexed.has(key), false); indexed.set(key, resolve(root, file))
  }
  const roundMetrics = { original: [[], [], []], current: [[], [], []] }, actualFiles = { original: [[], [], []], current: [[], [], []] }
  const roundCases = { original: [{}, {}, {}], current: [{}, {}, {}] }, signatures = {}, rawCaseStates = { original: [{}, {}, {}], current: [{}, {}, {}] }
  let referenceNodeExecutable
  for (const arm of ['original', 'current']) {
    const source = plan.arms[arm], manifest = JSON.parse(readFileSync(resolve(directory, source.manifest), 'utf8'))
    for (let shard = 1; shard <= source.shardCount; shard++) {
      let first
      for (let round = 0; round < 3; round++) {
        const file = indexed.get(`${arm}:${shard}:${round}`); assert.ok(file)
        const row = JSON.parse(readFileSync(file, 'utf8')); assert.equal(row.qualified, true); assert.deepEqual(row.errors, [])
        assert.equal(row.arm, arm); assert.equal(row.shard, shard); assert.equal(row.round, round)
        const prefix = file.replace(/-summary\.json$/, '')
        const checked = validateReferenceSample(row, prefix, plan, { payload: dirname(file), definitionSha: process.env.GITHUB_SHA, runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT })
        assert.equal(row.originalAdmissionResultSha256, plan.originalAdmission.resultSha256)
        assert.ok(Number.isFinite(row.seconds) && row.seconds > 0)
        if (referenceNodeExecutable) assert.equal(row.host.nodeExecutable, referenceNodeExecutable)
        else referenceNodeExecutable = row.host.nodeExecutable
        const hostSignature = { host: row.host, callerEnv: row.callerEnv, canonicalCases: checked.canonical, signature: checked.signature }
        if (first) assert.deepEqual(hostSignature, first, 'Counted cold/warm cases/statuses/ordinals/config/runtime inputs differ')
        else first = hostSignature
        const commonSignature = { ...checked.signature, projects: checked.signature.projects.map(project => ({ ...project, ...(arm === 'current' ? { fsModuleCachePath: '<verified-owned-current-shard-cache>' } : {}) })) }
        if (signatures[arm]) assert.deepEqual(commonSignature, signatures[arm], 'Stock project/setup/flags differ between held hosts')
        else signatures[arm] = commonSignature
        actualFiles[arm][round].push(...checked.files)
        roundCases[arm][round][shard] = { canonicalCaseSha256: sha(JSON.stringify(checked.canonical)), cases: checked.canonical.length }
        roundMetrics[arm][round].push(row.seconds)
        for (const [status, count] of Object.entries(checked.rawCaseStates)) rawCaseStates[arm][round][status] = (rawCaseStates[arm][round][status] ?? 0) + count
        result.samples.push({ arm, shard, round, sourceSha: row.sourceSha, seconds: row.seconds, startedAt: row.startedAt, finishedAt: row.finishedAt, host: row.host, callerEnv: row.callerEnv, cacheDirectory: row.cacheDirectory, cacheExistedBefore: row.cacheExistedBefore, cacheEvidence: row.cacheEvidence, peakSampledCgroupBytes: checked.resourcePeakBytes, rawCasesSha256: sha(JSON.stringify(checked.raw)), canonicalCasesSha256: sha(JSON.stringify(checked.canonical)), summarySha256: sha(readFileSync(file)), rawReportSha256: checked.rawReportSha256, detailsSha256: checked.detailsSha256, timingSha256: checked.timingSha256, resourcesSha256: row.resourceSha256, rawLogSha256: row.rawLogSha256, resourcePreflightSha256: row.resourcePreflightSha256, rawCaseStates: checked.rawCaseStates, artifactSummaryPath: file })
      }
    }
    for (let round = 0; round < 3; round++) {
      assert.deepEqual(actualFiles[arm][round].sort(), manifest.files); assert.equal(new Set(actualFiles[arm][round]).size, source.physicalFiles)
      assert.deepEqual(roundCases[arm][round], roundCases[arm][0])
      assert.deepEqual(rawCaseStates[arm][round], rawCaseStates[arm][0])
      if (arm === 'original') assert.deepEqual(rawCaseStates[arm][round], plan.originalAdmission.rawCaseStates, 'Original source registration/status totals must retain its complete qualified admission')
    }
  }
  result.rounds = [0, 1, 2].map(round => {
    const before = Math.max(...roundMetrics.original[round]), after = Math.max(...roundMetrics.current[round])
    return { round, stage: round === 0 ? 'Counted first complete transform-cache round; OS/native/package caches not guaranteed cold' : 'Counted current warm transform cache; original module cache remains disabled', originalMaximumSeconds: before, currentMaximumSeconds: after, criticalMaxRatio: before / after, lessTimePercent: 100 * (1 - after / before), originalAggregateCommandSeconds: roundMetrics.original[round].reduce((a, b) => a + b, 0), currentAggregateCommandSeconds: roundMetrics.current[round].reduce((a, b) => a + b, 0) }
  })
  const mean = key => result.rounds.reduce((sum, row) => sum + row[key], 0) / 3
  result.meanOriginalCriticalMaxSeconds = mean('originalMaximumSeconds'); result.meanCurrentCriticalMaxSeconds = mean('currentMaximumSeconds')
  result.meanCriticalMaxRatio = result.meanOriginalCriticalMaxSeconds / result.meanCurrentCriticalMaxSeconds
  result.allThreeCriticalMaxRatiosAtLeastTwo = result.rounds.every(row => row.criticalMaxRatio >= 2) && result.meanCriticalMaxRatio >= 2
  result.perRevisionRawCaseStates = rawCaseStates; result.perRevisionRoundCaseDigests = roundCases; result.resolvedProjectSignatures = signatures
  result.sources = { original: plan.arms.original.sourceSha, current: plan.arms.current.sourceSha }
  result.physicalFiles = { original: plan.arms.original.physicalFiles, current: plan.arms.current.physicalFiles }
  result.rawIdentityScope = 'All original/current raw maps remain in every uploaded report/summary. Only exact two database suffixes and one UUIDv4 readiness title normalize; assertion ordinals, multiplicity, ancestors/statuses and all five other readiness literals remain. No cross-revision full case equivalence inferred.'
  result.resourceScope = 'Sampled memory is the sampler/service-cgroup observation, not proof all held child/descendants remain in it. Five original versus ten current ARM4 hosts,20→40 nominal worker slots. Counted command maxima are unsynchronized critical-path proxies, not workflow/PR latency. Dispatch/provisioning/install/cache/artifact/all held costs require the separate raw workflow job ledger. Remote filesystem symlink resolution and inode identity are producer-observed and retained; the collector independently replays raw membership/mount/PID evidence but cannot restat a terminated remote host. Different actual hosts, source growth, V4→V5, five→six setups, cache and runtime changes prevent causal-only or historical542 claims.'
  result.qualified = true
} catch (error) { result.qualified = false; result.errors.push(inspect(error)); process.exitCode = 1 }
writeFileSync(output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' })
console.log(JSON.stringify({ qualified: result.qualified, samples: result.samples.length, errors: result.errors, rounds: result.rounds, meanCriticalMaxRatio: result.meanCriticalMaxRatio }))
