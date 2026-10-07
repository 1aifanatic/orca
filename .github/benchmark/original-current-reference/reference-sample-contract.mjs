import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { relative, resolve, posix } from 'node:path'
import { canonicalCases } from './canonical-case-identities.mjs'

export const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const json = file => JSON.parse(readFileSync(file, 'utf8'))
export function canonicalOrdinals(raw, files) {
  assert.equal(new Set(raw.map(row => JSON.stringify([row.file, row.assertionIndex]))).size, raw.length)
  assert.ok(raw.every(row => Number.isInteger(row.assertionIndex) && row.assertionIndex >= 0))
  const canonical = canonicalCases(raw, files)
  assert.equal(canonical.length, raw.length)
  canonical.forEach((row, index) => {
    assert.equal(row.file, raw[index].file); assert.equal(row.assertionIndex, raw[index].assertionIndex)
    assert.equal(row.status, raw[index].status); assert.deepEqual(row.ancestorTitles, raw[index].ancestorTitles)
  })
  return canonical.sort((a, b) => a.file.localeCompare(b.file) || a.assertionIndex - b.assertionIndex)
}
function replayResourceBinding(preflight, binding) {
  assert.equal(preflight.qualified, true); assert.deepEqual(preflight.binding, binding)
  const decode = value => value.replace(/\\([0-7]{3})/g, (_, digits) => String.fromCharCode(parseInt(digits, 8)))
  const memberships = preflight.inputs.membershipRaw.split('\n').filter(line => line.startsWith('0::'))
  assert.equal(memberships.length, 1)
  const membership = decode(memberships[0].slice(3))
  assert.equal(binding.membershipRaw, preflight.inputs.membershipRaw); assert.equal(binding.membership, membership)
  assert.ok(membership.startsWith('/') && !membership.split('/').includes('..'))
  assert.ok(preflight.inputs.mountLines.includes(binding.mountLine))
  const parts = binding.mountLine.split(' - '); assert.equal(parts.length, 2); assert.equal(parts[1].split(' ')[0], 'cgroup2')
  const fields = parts[0].split(' '), mountRoot = decode(fields[3]), mountPoint = decode(fields[4])
  assert.equal(binding.mountRoot, mountRoot); assert.equal(binding.mountPoint, mountPoint)
  assert.ok(posix.isAbsolute(mountRoot) && posix.isAbsolute(mountPoint) && posix.isAbsolute(binding.realMount))
  assert.ok(membership === mountRoot || mountRoot === '/' || membership.startsWith(mountRoot + '/'))
  const inside = posix.relative(mountRoot, membership)
  assert.ok(!inside.startsWith('../') && !posix.isAbsolute(inside))
  assert.equal(binding.group, posix.resolve(binding.realMount, inside))
  assert.equal(binding.procs, posix.join(binding.group, 'cgroup.procs'))
  assert.equal(binding.current, posix.join(binding.group, 'memory.current'))
  assert.equal(binding.memoryEvents, posix.join(binding.group, 'memory.events'))
  assert.ok(Number.isInteger(binding.ownerPid) && binding.ownerPid > 1)
  const procs = preflight.inputs.procsByMount.filter(row => row.mountLine === binding.mountLine && row.procs === binding.procs)
  assert.equal(procs.length, 1); assert.ok(procs[0].procsRaw.trim().split(/\s+/).includes(String(binding.ownerPid)))
  for (const identity of [binding.groupIdentity, binding.currentIdentity, binding.eventsIdentity]) {
    assert.match(identity.dev, /^\d+$/); assert.match(identity.ino, /^\d+$/)
  }
}
export function validateReferenceSample(row, prefix, plan, context) {
  assert.equal(sha(readFileSync(import.meta.filename)), plan.payloadSha256['reference-sample-contract.mjs'])
  assert.equal(sha(readFileSync(resolve(import.meta.dirname, 'canonical-case-identities.mjs'))), plan.payloadSha256['canonical-case-identities.mjs'])
  const arm = plan.arms[row.arm]; assert.ok(arm)
  assert.deepEqual(row.adjustedBaseline, plan.adjustedBaseline)
  assert.equal(plan.adjustedBaseline.pristineFailedAttemptPermanentlyUnqualified, true)
  assert.equal(plan.adjustedBaseline.notPristineOrHistorical2xSubstitution, true)
  const manifest = json(resolve(context.payload, arm.manifest))
  assert.ok(arm); assert.ok([0, 1, 2].includes(row.round))
  assert.ok(Number.isInteger(row.shard) && row.shard >= 1 && row.shard <= arm.shardCount)
  const files = manifest.shards[row.shard - 1].files
  assert.equal(row.sourceSha, arm.sourceSha); assert.equal(row.result.code, 0); assert.equal(row.result.signal, null)
  assert.ok(!row.launchError); assert.equal(row.lifecycleError, false); assert.deepEqual(row.lingeringCoordinators, [])
  assert.ok(row.samples.length >= 2 && row.samples.every(sample => !sample.error && sample.noiseGuardAvailable === true && sample.coordinators.every(process => process.owned === true)))
  assert.deepEqual(row.samples.at(-1).coordinators, [])
  assert.equal(row.host.definitionSha, context.definitionSha); assert.equal(row.host.runId, context.runId); assert.equal(row.host.runAttempt, context.runAttempt)
  assert.equal(row.host.nodeVersion, plan.nodeVersion); assert.equal(row.host.platform, 'linux'); assert.equal(row.host.arch, 'arm64'); assert.equal(row.host.logicalCpus, 4)
  assert.equal(row.host.vitestVersion, arm.vitestVersion)
  if (row.arm === 'current') assert.equal(row.host.bunRevision, plan.bunRevision)
  assert.deepEqual(row.before, row.after); assert.deepEqual(row.before.sources, arm.sourceSha256)
  assert.equal(row.before.head, arm.sourceSha); assert.equal(row.before.diff, sha(''))
  assert.deepEqual(row.payloadSha256, plan.payloadSha256); assert.equal(row.planSha256, sha(readFileSync(resolve(context.payload, 'reference-plan.json')))); assert.equal(row.planSha256, sha(readFileSync(resolve(import.meta.dirname, 'reference-plan.json'))))
  for (const [file, expected] of Object.entries(plan.payloadSha256)) assert.equal(sha(readFileSync(resolve(context.payload, file))), expected)
  assert.equal(row.actualAssignment.sourceSha, arm.sourceSha); assert.equal(row.actualAssignment.selectedShard, row.shard)
  assert.equal(row.actualAssignment.runId, context.runId); assert.equal(row.actualAssignment.runAttempt, context.runAttempt)
  assert.equal(row.actualAssignment.baselineSha256, manifest.baselineSha256); assert.deepEqual(row.actualAssignment.shards, manifest.shards)
  assert.deepEqual(row.files, files); assert.deepEqual(manifest.shards.flatMap(shard => shard.files).sort(), manifest.files)
  const report = json(prefix + '.json'), details = json(prefix + '-details.json'), timing = json(prefix + '-timings.json')
  assert.equal(report.success, true); assert.equal(report.numFailedTests, 0)
  const actualFiles = report.testResults.map(module => relative(row.sourceRoot, module.name).replaceAll('\\', '/')).sort()
  assert.deepEqual(actualFiles, files); assert.equal(new Set(actualFiles).size, files.length)
  const raw = report.testResults.flatMap(module => module.assertionResults.map((test, assertionIndex) => ({ assertionIndex, file: relative(row.sourceRoot, module.name).replaceAll('\\', '/'), fullName: test.fullName, title: test.title, ancestorTitles: test.ancestorTitles, status: test.status })))
  assert.deepEqual(raw, row.rawCases); assert.equal(raw.length, report.numTotalTests)
  assert.ok(raw.every(test => ['passed', 'pending', 'todo', 'skipped'].includes(test.status)))
  const rawCaseStates = raw.reduce((counts, test) => { counts[test.status] = (counts[test.status] ?? 0) + 1; return counts }, {})
  assert.equal(rawCaseStates.failed ?? 0, 0)
  assert.equal(rawCaseStates.passed ?? 0, report.numPassedTests)
  assert.equal((rawCaseStates.pending ?? 0) + (rawCaseStates.skipped ?? 0), report.numPendingTests)
  assert.equal(rawCaseStates.todo ?? 0, report.numTodoTests)
  assert.equal(report.numTotalTests, report.numPassedTests + report.numPendingTests + report.numTodoTests + report.numFailedTests)
  const canonical = canonicalOrdinals(raw, files)
  assert.deepEqual(canonical, row.canonicalCases)
  assert.equal(details.reason, 'passed'); assert.deepEqual(details.errors, []); assert.deepEqual(details, row.details)
  assert.equal(details.rootIsolation, true); assert.equal(details.resolvedRootMaxWorkers, 4)
  assert.equal(details.rootFsModuleCache, row.arm === 'current'); assert.equal(details.experimentalFsModuleCache, false)
  assert.equal(details.projects.length, row.arm === 'current' ? 3 : 1)
  assert.ok(details.projects.every(project => project.effectiveMaxWorkers === 4 && project.isolate === true && project.testTimeout === 30000 && project.hookTimeout === 60000))
  for (const project of details.projects) {
    assert.deepEqual(project.execArgv, arm.execArgv); assert.deepEqual(project.setups, arm.setupFiles)
    assert.equal(project.fsModuleCache, row.arm === 'current'); assert.equal(project.experimentalFsModuleCache, false)
    if (row.arm === 'original') assert.equal(project.pool, 'forks')
    else assert.equal(project.pool, project.name === 'bun' ? 'forks' : 'node-runtime')
  }
  assert.deepEqual(details.modules.map(module => module.file).sort(), files)
  assert.equal(new Set(details.modules.map(module => module.file)).size, files.length)
  assert.ok(details.modules.every(module => ['passed', 'skipped'].includes(module.state)))
  for (const module of details.modules) {
    if (row.arm === 'original') {
      assert.equal(module.pool, 'forks'); assert.ok(details.projects.some(project => project.name === module.project && project.pool === 'forks'))
    } else {
      assert.equal(module.project, manifest.routes[module.file]); assert.equal(module.pool, module.project === 'bun' ? 'forks' : 'node-runtime')
    }
  }
  assert.equal(timing.status, 'passed'); assert.equal(timing.unhandledErrors, 0)
  assert.deepEqual(Object.keys(timing.results).sort(), files); assert.ok(Object.values(timing.results).every(state => ['passed', 'skipped'].includes(state)))
  assert.equal(timing.nodeVersion, plan.nodeVersion); assert.equal(timing.sourceSha, arm.sourceSha); assert.equal(timing.runId, context.runId); assert.equal(timing.runAttempt, context.runAttempt)
  assert.deepEqual(timing.shard, { index: row.shard, count: arm.shardCount })
  const expectedArgv = row.arm === 'original'
    ? ['exec', 'vitest', 'run', '--config', 'config/vitest.config.ts', `--shard=${row.shard}/5`, '--maxWorkers=4']
    : ['test', `--shard=${row.shard}/10`, `--fsModuleCachePath=${row.cacheDirectory}`, '--maxWorkers=4']
  expectedArgv.push('--reporter=default', '--reporter=json', '--reporter=./config/scripts/ci-unit-timing-reporter.mjs', '--reporter=./.github/benchmark/original-current-reference/reference-reporter.mjs', `--outputFile=${resolve(row.sourceRoot, '.github/benchmark/original-current-reference', `${row.arm}-shard-${row.shard}-round-${row.round}.json`)}`)
  assert.deepEqual(row.argv, expectedArgv)
  assert.ok(!/Timeout terminating|failed to terminate.*worker|worker.*termination.*timed out|Unhandled Errors/i.test(readFileSync(prefix + '.log', 'utf8')))
  assert.equal(sha(readFileSync(prefix + '-resources.jsonl')), row.resourceSha256)
  const resources = readFileSync(prefix + '-resources.jsonl', 'utf8').trim().split('\n').map(line => JSON.parse(line))
  assert.ok(resources.length >= 2)
  const preflight = json(prefix + '-resource-preflight.json'); replayResourceBinding(preflight, row.cgroupBinding)
  assert.equal(sha(readFileSync(prefix + '-resource-preflight.json')), row.resourcePreflightSha256)
  assert.equal(sha(readFileSync(prefix + '.log')), row.rawLogSha256)
  const counters = record => Object.fromEntries(['oom', 'oom_kill'].map(key => {
    const value = record.cgroupEvents?.match(new RegExp(`^${key} (\\d+)$`, 'm'))?.[1]; assert.ok(value !== undefined); return [key, value]
  }))
  for (const record of resources) {
    assert.deepEqual(record.binding, row.cgroupBinding)
    assert.equal(record.membershipRaw, row.cgroupBinding.membershipRaw); assert.equal(record.mountLine, row.cgroupBinding.mountLine)
    assert.ok(record.procsRaw.trim().split(/\s+/).includes(String(row.cgroupBinding.ownerPid)))
    assert.deepEqual(record.eventCounters, counters(record)); assert.deepEqual(record.eventCounters, resources[0].eventCounters); assert.match(record.cgroupCurrent, /^\d+$/)
  }
  if (row.arm === 'current') {
    assert.equal(row.cacheDirectory, resolve(row.sourceRoot, '.github/benchmark/original-current-reference/cache', `current-shard-${row.shard}`))
    assert.equal(row.cacheExistedBefore, row.round !== 0); assert.equal(row.cacheExistsAfter, true)
    assert.ok(Number.isInteger(row.cacheEvidence.physicalFiles) && row.cacheEvidence.physicalFiles > 0)
    assert.equal(resolve(details.rootFsModuleCachePath), row.cacheDirectory)
    assert.ok(details.projects.every(project => resolve(project.fsModuleCachePath) === row.cacheDirectory))
  } else { assert.equal(row.cacheDirectory, null); assert.equal(row.cacheExistedBefore, null); assert.equal(row.cacheExistsAfter, null) }
  const signature = { rootFsModuleCache: details.rootFsModuleCache, experimentalFsModuleCache: details.experimentalFsModuleCache, rootIsolation: details.rootIsolation, maxWorkers: details.resolvedRootMaxWorkers, projects: details.projects }
  return { raw, rawCaseStates, canonical, signature, files, fileStates: timing.results, resourcePeakBytes: Math.max(...resources.map(record => Number(record.cgroupCurrent))), rawReportSha256: sha(readFileSync(prefix + '.json')), detailsSha256: sha(readFileSync(prefix + '-details.json')), timingSha256: sha(readFileSync(prefix + '-timings.json')) }
}
