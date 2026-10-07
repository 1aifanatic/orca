import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, openSync, closeSync, globSync, readdirSync } from 'node:fs'
import { loadavg, arch, cpus, platform, release, totalmem } from 'node:os'
import { resolve, relative, matchesGlob } from 'node:path'
import { performance } from 'node:perf_hooks'
import { spawnProcess, runProcessSync } from '../../../../config/scripts/script-child-process.mjs'

const [arm, roundArgument, shardArgument, planArgument = 'notes/bun-migration/performance/serialize-grid-cpu-explicit-worker-argv-diagnostic/measurement-plan.json'] = process.argv.slice(2)
assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Desktop full-suite execution is blocked: unchanged native teardown still has numeric-PID/group signaling hazards. Use a dedicated isolated CI runner, without exclusions.')
assert.equal(arm, 'four', 'One stock four-worker observational command only')
assert.equal(roundArgument, '0', 'One diagnostic command; no benchmark pairs or independent cold-host claim')
const round = Number(roundArgument)
const phase = round === 0 ? 'cold' : 'warm'
const shard = Number(shardArgument)
assert.ok(Number.isInteger(shard) && shard >= 1 && shard === 1, 'One selected one-file diagnostic only')
const root = process.cwd(), directory = resolve('notes/bun-migration/performance')
const planPath = resolve(planArgument)
const plan = JSON.parse(readFileSync(planPath, 'utf8'))
assert.match(plan.label, /^[a-z][a-z0-9-]*$/, 'Use a bounded artifact label')
const sha = value => createHash('sha256').update(value).digest('hex')
const manifest = JSON.parse(readFileSync(plan.manifest, 'utf8'))
const expectedAssignment = JSON.parse(readFileSync(plan.assignment, 'utf8'))
const files = expectedAssignment.shards[shard - 1].files
assert.equal(manifest.sourceSha, plan.sourceSha)
assert.equal(manifest.files.length, plan.physicalFiles)
assert.equal(manifest.fullFiles.length, plan.fullDiscoveryPhysicalFiles)
assert.equal(manifest.files.length, 1)
assert.ok(manifest.files.every(file => manifest.fullFiles.includes(file)))
assert.equal(manifest.files.includes(plan.measurementFile), false)
assert.equal(expectedAssignment.shards.length, 1)
const discovered = globSync(manifest.includes, { cwd: root, exclude: manifest.excludes }).map(file => file.replaceAll('\\', '/')).sort()
assert.deepStrictEqual(discovered, manifest.fullFiles, 'Actual worktree discovery differs from the named source manifest')
assert.equal(new Set(files).size, files.length)
const git = args => {
  const r = runProcessSync({ program: 'git', args, env: { ...process.env, GIT_NO_LAZY_FETCH: '1' }, timeoutMs: 5000, maxOutputBytes: 2 * 1024 * 1024 })
  assert.equal(r.code, 0); assert.equal(r.outputTruncated, false)
  return r.stdout
}
const sourceHashes = plan.sourceSha256
for (const [path, expected] of Object.entries(sourceHashes)) assert.equal(sha(readFileSync(path)), expected, `${phase} source changed: ${path}`)
const expectedHead = plan.sourceSha
const requestedWorkers = plan.workerCaps[arm]
assert.equal(requestedWorkers, 4)
const bunRevision = runProcessSync({ program: 'bun', args: ['--revision'], timeoutMs: 5000, maxOutputBytes: 65536 })
assert.equal(bunRevision.code, 0); assert.equal(bunRevision.outputTruncated, false)
const host = { platform: platform(), arch: arch(), release: release(), cpuModel: cpus()[0]?.model, logicalCpus: cpus().length, totalMemory: totalmem(), nodeVersion: process.versions.node, nodeExecutable: process.execPath, bunRevision: bunRevision.stdout.trim(), vitestVersion: JSON.parse(readFileSync('node_modules/vitest/package.json', 'utf8')).version }
const callerEnv = Object.fromEntries(['NODE_OPTIONS', 'NODE_COMPILE_CACHE', 'NODE_DISABLE_COMPILE_CACHE', 'ORCA_TEST_NODE_EXECUTABLE', 'ORCA_TEST_NODE_VERSION', 'ORCA_UNIT_SELECTION_PLAN', 'ORCA_SHARD_SOURCE_SHA', 'ORCA_REQUIRED_TEST_INPUTS', 'ORCA_PINNED_NODE', 'BUN_EXECUTABLE', 'ORCA_REAL_CLAUDE_CLI_TEST'].map(key => [key, process.env[key] ?? null]))
const callerRuntimeEnvSha256 = sha(JSON.stringify(Object.entries(process.env).filter(([key]) => /^(?:ORCA_|BUN_|NODE_OPTIONS$|NODE_COMPILE_CACHE$|NODE_DISABLE_COMPILE_CACHE$|ELECTRON_RUN_AS_NODE$)/.test(key)).sort(([a], [b]) => a.localeCompare(b))))
assert.ok(!callerEnv.ORCA_TEST_NODE_EXECUTABLE || callerEnv.ORCA_TEST_NODE_EXECUTABLE === host.nodeExecutable, 'Do not override the actual Node authority')
assert.ok(!callerEnv.ORCA_TEST_NODE_VERSION || callerEnv.ORCA_TEST_NODE_VERSION === host.nodeVersion, 'Do not override the actual Node patch')
assert.equal(host.nodeVersion, plan.nodeVersion, 'Exact same Node patch on every runner')
assert.ok(host.bunRevision.startsWith(plan.bunVersion + '+'), 'Exact pinned Bun release')
assert.equal(host.vitestVersion, plan.vitestVersion, 'Plan is qualified only for the installed Vitest5.0.3')
assert.ok(!callerEnv.ORCA_UNIT_SELECTION_PLAN && !callerEnv.ORCA_SHARD_SOURCE_SHA, 'Do not inherit a caller selection plan; use only the reviewed one-file selection')
const config = plan.diagnosticConfig
const stockConfig = 'config/vitest.config.ts'
const reporter = 'notes/bun-migration/performance/persistence-import-reuse-benchmark-reporter.mjs'
const fingerprint = () => ({
  head: git(['rev-parse', 'HEAD']).trim(), diffSha256: sha(git(['diff', '--binary', 'HEAD'])),
  unrelatedDiffSha256: sha(git(['diff', '--binary', 'HEAD', '--', '.', ...Object.keys(sourceHashes).map(path => `:(exclude)${path}`)])),
  installedOwnerHashes: Object.fromEntries(Object.keys(plan.installedOwnerHashes).map(path => [path, sha(readFileSync(path))])), configSha256: sha(readFileSync(stockConfig)), diagnosticConfigSha256: sha(readFileSync(config)), reporterSha256: sha(readFileSync(reporter)), planSha256: sha(readFileSync(planPath)), harnessSha256: sha(readFileSync(import.meta.filename))
})
const before = fingerprint(); assert.deepStrictEqual(before.installedOwnerHashes, plan.installedOwnerHashes); assert.equal(before.head, expectedHead, 'Unexpected frozen source head')
assert.equal(before.diffSha256, sha(''), 'Frozen full-suite source must be clean')
const freezePath = resolve(directory, `${plan.label}-benchmark-freeze.json`)
const commonFreeze = { expectedAssignmentSha256: sha(readFileSync(plan.assignment)), fullSelectionSha256: sha(readFileSync(plan.fullSelectionPlan)), effectiveLauncherEnv: { ORCA_BACKGROUND_LAUNCH: '1', ORCA_BALANCE_UNIT_SHARDS: '1', ORCA_SHARD_SOURCE_SHA: plan.sourceSha, ORCA_UNIT_SELECTION_PLAN: resolve(plan.fullSelectionPlan) }, host, callerEnv, callerRuntimeEnvSha256, expectedHead, unrelatedDiffSha256: before.unrelatedDiffSha256, configSha256: before.configSha256, diagnosticConfigSha256: before.diagnosticConfigSha256, reporterSha256: before.reporterSha256, planSha256: before.planSha256, harnessSha256: before.harnessSha256 }
if (existsSync(freezePath)) assert.deepStrictEqual(JSON.parse(readFileSync(freezePath, 'utf8')), commonFreeze)
else writeFileSync(freezePath, JSON.stringify(commonFreeze, null, 2) + '\n')
const observedDescendantCoordinators = new Set()
function snapshot(heldChild) {
  if (process.platform === 'win32') return { noiseGuardAvailable: false, coordinators: [], load: loadavg() }
  const r = runProcessSync({ program: 'ps', args: ['-axo', 'pid=,ppid=,command='], timeoutMs: 5000, maxOutputBytes: 2 * 1024 * 1024 })
  assert.equal(r.code, 0); assert.equal(r.outputTruncated, false)
  const rows = r.stdout.split('\n').flatMap(line => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/)
    if (!match) return []
    return [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] }]
  })
  const parents = new Map(rows.map(row => [row.pid, row.ppid]))
  const childHeld = heldChild?.pid && heldChild.exitCode === null && heldChild.signalCode === null
  const descendsFromHeldChild = pid => {
    if (!childHeld) return false
    const visited = new Set()
    while (pid > 1 && !visited.has(pid)) {
      if (pid === heldChild.pid) return true
      visited.add(pid)
      pid = parents.get(pid) ?? 0
    }
    return false
  }
  const coordinators = rows.flatMap(row => {
    const executable = row.command.split(/\s+/, 1)[0].replaceAll('\\', '/').split('/').at(-1)
    if (!['node', 'bun'].includes(executable) || !/(vitest\.mjs|run-vitest\.mjs|\bbun\s+test\b)/.test(row.command)) return []
    const owned = descendsFromHeldChild(row.pid)
    if (owned) observedDescendantCoordinators.add(row.pid)
    return [{ pid: row.pid, ppid: row.ppid, owned,
      observedAsDescendantWhileChildHeld: observedDescendantCoordinators.has(row.pid) }]
  })
  return { noiseGuardAvailable: true, coordinators, load: loadavg() }
}
const cacheDirectory = resolve(plan.cacheDirectory, `shard-${shard}`, arm)
const cacheRelative = relative(resolve('notes/bun-migration/performance/serialize-grid-cpu-explicit-worker-argv-diagnostic'), cacheDirectory)
assert.ok(cacheRelative && !cacheRelative.startsWith('..') && !cacheRelative.includes(':'), 'Cache must be owned by this ignored proposal')
if (phase === 'cold') assert.equal(existsSync(cacheDirectory), false, 'Cold cache must be fresh; never delete or relabel existing cache')
else assert.ok(existsSync(cacheDirectory), 'Warm run requires the counted cold cache seed')
const expectedRoutes = files.map(file => ({
  file,
  project: file === plan.measurementFile ? 'node-measurement' : plan.nodeRuntimeIncludes.some(pattern => matchesGlob(file, pattern)) ? 'node-runtime' : 'bun',
  pool: file === plan.measurementFile || plan.nodeRuntimeIncludes.some(pattern => matchesGlob(file, pattern)) ? 'node-runtime' : 'forks'
}))
const signaturePath = resolve(directory, `${plan.label}-shard-${shard}-${arm}-resolved-project-signature.json`)

const label = resolve(directory, `${plan.label}-shard-${shard}-${arm}-${round}`)
assert.ok(!existsSync(label + '-summary.json'), 'Do not overwrite a counted sample')
assert.equal(process.env.BUN_CPU_PROFILE, undefined); assert.equal(process.env.BUN_CPU_PROFILE_DIR, undefined); assert.equal(process.env.BUN_CPU_PROFILE_NAME, undefined);
assert.ok(resolve(plan.profileDirectory).startsWith(resolve('notes/bun-migration/performance/serialize-grid-cpu-explicit-worker-argv-diagnostic') + '/'));
const profilerExecArgv = ['--cpu-prof', `--cpu-prof-dir=${resolve(plan.profileDirectory)}`]
assert.equal(sha(readFileSync(config)), plan.diagnosticConfigSha256)
const command = ['pnpm', 'test', `--config=${config}`, `--shard=${shard}/1`, ...plan.importDurationFlags, `--fsModuleCachePath=${cacheDirectory}`, `--maxWorkers=${requestedWorkers}`, '--reporter=default', '--reporter=json', `--reporter=./${reporter}`, `--outputFile=${label}.json`]
assert.deepStrictEqual(readdirSync(plan.profileDirectory), [], 'Owned profile directory must start empty; no overwritten/reused capture')
const samples = [snapshot(null)]; assert.equal(samples[0].coordinators.length, 0, 'Another coordinator is active')
const fd = openSync(label + '.log', 'wx')
let child, closed, sampling, launchError, fdClosed = false
try {
  const startedAt = new Date().toISOString()
  const start = performance.now()
  child = spawnProcess({ program: command[0], args: command.slice(1),
    cwd: root, stdio: ['ignore', fd, fd],
    env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1', ORCA_BALANCE_UNIT_SHARDS: '1', ORCA_SHARD_SOURCE_SHA: plan.sourceSha, ORCA_UNIT_SELECTION_PLAN: resolve(plan.fullSelectionPlan), ORCA_SHARD_MANIFEST: label + '-assignment.json', ORCA_IMPORT_REUSE_DETAILS: label + '-details.json' } })
  closed = new Promise(done => {
    child.once('error', error => { launchError = String(error); done({ code: null, signal: null }) })
    child.once('close', (code, signal) => done({ code, signal }))
  })
  sampling = setInterval(() => { try { samples.push(snapshot(child)) } catch (error) { samples.push({ error: String(error) }) } }, 5000)
  const result = await closed
  const seconds = (performance.now() - start) / 1000
  const finishedAt = new Date().toISOString()
  clearInterval(sampling)
  closeSync(fd); fdClosed = true; samples.push(snapshot(child))
  const lingeringCoordinators = samples.at(-1).coordinators
  const after = fingerprint(), report = existsSync(label + '.json') ? JSON.parse(readFileSync(label + '.json', 'utf8')) : null
  const details = existsSync(label + '-details.json') ? JSON.parse(readFileSync(label + '-details.json', 'utf8')) : null
  const physicalFile = name => relative(root, name).replaceAll('\\', '/')
  const rawIdentities = report?.testResults.flatMap(module => module.assertionResults.map(test => ({ file: physicalFile(module.name), fullName: test.fullName, status: test.status, title: test.title, ancestorTitles: test.ancestorTitles })))
  let identities, normalizationError = null
  if (rawIdentities) {
    try { identities = rawIdentities } catch (error) { normalizationError = String(error) }
  }
  const expectedIdentities = plan.expectedRawCaseIdentities
  const sortCases = cases => cases.map(({ file, fullName, title, ancestorTitles, status }) => JSON.stringify([file, fullName, title, ancestorTitles, status])).sort()
  const caseParity = identities && (expectedIdentities && JSON.stringify(sortCases(identities)) === JSON.stringify(sortCases(expectedIdentities)))
  const filesEqual = report?.testResults.length === files.length && JSON.stringify(report.testResults.map(module => physicalFile(module.name)).sort()) === JSON.stringify([...files].sort())
  const cacheEnabled = details?.rootFsModuleCache === true && details.projects.every(project => project.fsModuleCache === true)
  const setupPreserved = details?.projects.length === 3 && details.projects.every(project => JSON.stringify(project.setups) === JSON.stringify(plan.expectedSetups) && JSON.stringify(project.execArgv) === JSON.stringify(project.name === 'bun' ? [...plan.expectedExecArgv, ...profilerExecArgv] : plan.expectedExecArgv) && project.testTimeout === 30000 && project.hookTimeout === 60000)
  const caseCountsPreserved = report?.testResults.every(module => {
    const expected = plan.expectedCaseCounts[physicalFile(module.name)]
    const cases = module.assertionResults
    return expected && cases.length === expected.total && cases.filter(test => test.status === 'pending').length === expected.pending && cases.filter(test => test.status === 'passed').length === expected.passed
  })
  const sortRoutes = routes => [...routes].sort((a,b) => a.file.localeCompare(b.file))
  const routes = details?.modules.map(({ diagnostic, ...route }) => route)
  const routePreserved = routes?.length === files.length && JSON.stringify(sortRoutes(routes)) === JSON.stringify(sortRoutes(expectedRoutes))
  const isolationPreserved = details?.rootIsolation === true && details.projects.every(project => project.isolate === true)
  const workerCapPreserved = details?.resolvedRootMaxWorkers === requestedWorkers && details.projects.every(project => project.effectiveMaxWorkers === requestedWorkers)
  const resolvedProjectSignature = details && {
    rootFsModuleCache: details.rootFsModuleCache, rootIsolation: details.rootIsolation,
    resolvedRootMaxWorkers: details.resolvedRootMaxWorkers,
    projects: [...details.projects].sort((a, b) => a.name.localeCompare(b.name))
  }
  const expectedSignature = existsSync(signaturePath) ? JSON.parse(readFileSync(signaturePath, 'utf8')) : null
  const projectSignatureParity = phase === 'cold' ? expectedSignature === null : expectedSignature !== null && JSON.stringify(resolvedProjectSignature) === JSON.stringify(expectedSignature)
  const actualAssignment = existsSync(label + '-assignment.json') ? JSON.parse(readFileSync(label + '-assignment.json', 'utf8')) : null
  const assignmentParity = actualAssignment?.sourceSha === plan.sourceSha && actualAssignment.selectedShard === shard && actualAssignment.baselineSha256 === expectedAssignment.baselineSha256 && JSON.stringify(actualAssignment.shards) === JSON.stringify(expectedAssignment.shards)
  const sourceUnchanged = JSON.stringify(before) === JSON.stringify(after)
  const external = samples.some(sample => sample.error || sample.coordinators?.some(row => !row.owned))
  const lifecycleError = /Timeout terminating|failed to terminate.*worker|worker.*termination.*timed out|Unhandled Errors/i.test(readFileSync(label + '.log', 'utf8'))
  const qualified = !launchError && lingeringCoordinators.length === 0 && !external && !lifecycleError && result?.code === 0
    && report?.success && report.numTotalTests === identities?.length && report.numFailedTests === 0 && caseParity && filesEqual
    && assignmentParity && !normalizationError && projectSignatureParity && cacheEnabled && setupPreserved && caseCountsPreserved && routePreserved && isolationPreserved && workerCapPreserved && sourceUnchanged && details.errors.length === 0
  const row = { command, sourceRoot: root, ciScope: plan.ciScope, callerRuntimeEnvSha256, expectedAssignmentSha256: commonFreeze.expectedAssignmentSha256, fullSelectionSha256: commonFreeze.fullSelectionSha256, expectedNodeWorkerIdentity: { executable: host.nodeExecutable, nodeVersion: host.nodeVersion, evidence: 'Stock Node-authority fields and configured protected projects remain intact. The selected replay file runs in ordinary Bun/forks; dedicated runtime contracts are not enrolled.' }, effectiveLauncherEnv: { ORCA_BACKGROUND_LAUNCH: '1', ORCA_BALANCE_UNIT_SHARDS: '1', ORCA_SHARD_SOURCE_SHA: plan.sourceSha, ORCA_UNIT_SELECTION_PLAN: resolve(plan.fullSelectionPlan), ORCA_SHARD_MANIFEST: label + '-assignment.json' }, host, callerEnv, arm, shard, phase, round, startedAt, finishedAt, seconds, result, launchError, lingeringCoordinators, external, lifecycleError,
    caseParity, assignmentParity, normalizationError, projectSignatureParity, resolvedProjectSignature, filesEqual, cacheEnabled, setupPreserved, caseCountsPreserved, routePreserved, isolationPreserved, workerCapPreserved, sourceUnchanged, qualified, before, after, samples,
    noiseGuardAvailable: samples.every(sample => sample.noiseGuardAvailable), rawIdentities, identities, details,
    manifestSha256: sha(readFileSync(plan.manifest)), casePlanSha256: sha(readFileSync(planPath)),
    cpuProfilerDelivery: { selectedProject: 'bun', configuredExecArgv: [...plan.expectedExecArgv, ...profilerExecArgv], diagnosticConfig: config, originalEnvironmentProfilerVariablesAbsent: true }, scope: 'One unchanged replay-file stock pnpm CPU sampling diagnostic. Profiling overhead is retained; no benchmark, wall comparison, full-suite claim or optimizer adoption. Raw samples and timeDeltas require gap-aware interpretation under Bun issue44077.' }
  row.observationalQualified = qualified && row.noiseGuardAvailable
  writeFileSync(label + '-summary.json', JSON.stringify(row, null, 2) + '\n')
  console.log(JSON.stringify({ phase, round, seconds, qualified, caseParity, cacheEnabled, result }))
  assert.ok(row.observationalQualified, 'Attribution observation lacked source/workload/runtime qualification; retain raw evidence')
  if (round === 0) writeFileSync(signaturePath, JSON.stringify(resolvedProjectSignature, null, 2) + '\n')

} finally {
  clearInterval(sampling)
  if (!fdClosed) closeSync(fd)
}
