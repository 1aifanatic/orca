import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, openSync, closeSync, lstatSync, readdirSync } from 'node:fs'
import { loadavg, cpus, totalmem } from 'node:os'
import { resolve, relative } from 'node:path'
import { performance } from 'node:perf_hooks'
import { spawnProcess, runProcessSync } from '../../../../../config/scripts/script-child-process.mjs'

const [phase, roundArgument, planArgument = 'notes/bun-migration/performance/automation-six-suite-benchmark-plan.json'] = process.argv.slice(2)
assert.ok(['before', 'after'].includes(phase), 'Pass before|after and round0|1|2; root applies/reverts the patch between invocations')
assert.ok(['cold', '0', '1', '2'].includes(roundArgument), 'Round must be0,1or2; every round counts')
const round = roundArgument === 'cold' ? 'cold' : Number(roundArgument)
const root = process.cwd(), directory = resolve('notes/bun-migration/performance')
const planPath = resolve(planArgument)
const plan = JSON.parse(readFileSync(planPath, 'utf8'))
assert.match(plan.label, /^[a-z][a-z0-9-]*$/, 'Use a bounded artifact label')
const sha = value => createHash('sha256').update(value).digest('hex')
const files = plan.files
const git = args => {
  const r = runProcessSync({ program: 'git', args, env: { ...process.env, GIT_NO_LAZY_FETCH: '1' }, timeoutMs: 5000, maxOutputBytes: 2 * 1024 * 1024 })
  assert.equal(r.code, 0); assert.equal(r.outputTruncated, false)
  return r.stdout
}
assert.equal(process.env.GITHUB_ACTIONS, 'true', 'CI-only: unchanged native fixture is unsafe on a desktop')
assert.equal(plan.configurationOnly, true)
assert.ok(plan.compatibilityAdmission, 'Fresh corrected-source broad compatibility admission is required')
const admission = JSON.parse(readFileSync(plan.compatibilityAdmission.path, 'utf8'))
assert.equal(sha(readFileSync(plan.compatibilityAdmission.path)), plan.compatibilityAdmission.sha256)
assert.equal(admission.broadCompatibilityQualified, true)
assert.equal(admission.sourceHead, plan.sourceHead)
assert.equal(admission.snapshots.length, 8)
assert.ok(plan.stateBoundaryAdmission, 'The separate public-state/reset audit needs an explicit reviewed admission')
assert.equal(sha(readFileSync(plan.stateBoundaryAdmission.path)), plan.stateBoundaryAdmission.sha256)
const stateBoundary = JSON.parse(readFileSync(plan.stateBoundaryAdmission.path, 'utf8'))
assert.equal(stateBoundary.sourceHead, plan.sourceHead)
assert.equal(stateBoundary.reviewedForTimingAdmission, true)
assert.equal(process.env.ORCA_IMPORT_REUSE_BENCH_EXPECTED_HEAD, undefined)
for (const key of ['NODE_COMPILE_CACHE', 'NODE_DISABLE_COMPILE_CACHE', 'ORCA_BALANCE_UNIT_SHARDS', 'ORCA_UNIT_SELECTION_PLAN', 'ORCA_SHARD_SOURCE_SHA', 'ORCA_VITEST_RUNTIME', 'NODE_OPTIONS']) assert.equal(process.env[key], undefined, key)
const sourceHashes = plan.sourceBeforeSha256
assert.deepStrictEqual(sourceHashes, plan.sourceAfterSha256)
for (const [file, hash] of Object.entries(plan.configurationSourceHashes)) assert.equal(sha(readFileSync(file)), hash)
for (const [file, hash] of Object.entries(plan.installedHashes)) assert.equal(sha(readFileSync(file)), hash)
for (const [path, expected] of Object.entries(sourceHashes)) assert.equal(sha(readFileSync(path)), expected, `${phase} source changed: ${path}`)
assert.equal(git(['diff', '--binary', 'HEAD']), '', 'Configuration-only source must be pristine')
for (const [file, hash] of Object.entries(plan.identityProofFiles)) assert.equal(sha(readFileSync(file)), hash, 'Original case proof changed')
const expectedHead = plan.sourceHead
const config = 'config/vitest.config.ts'
const reporter = 'notes/bun-migration/performance/persistence-import-reuse-benchmark-reporter.mjs'
const runKey = process.env.GITHUB_RUN_ID + '-' + process.env.GITHUB_RUN_ATTEMPT
assert.match(runKey, /^\d+-\d+$/)
const runDirectory = resolve(plan.cacheRootPrefix, runKey)
const optimizerCache = resolve(runDirectory, phase + '-cache')
assert.ok(relative(resolve(plan.cacheRootPrefix), optimizerCache) && !relative(resolve(plan.cacheRootPrefix), optimizerCache).startsWith('..'))
function inventory(directory) {
  if (!existsSync(directory)) return null
  const files = []
  const visit = path => {
    assert.equal(lstatSync(path).isSymbolicLink(), false, 'No cache symlinks')
    assert.equal(lstatSync(path).isDirectory(), true, 'Cache root must be a directory')
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const target = resolve(path, entry.name)
      assert.equal(entry.isSymbolicLink(), false, 'No cache symlinks')
      if (entry.isDirectory()) visit(target)
      else { assert.ok(entry.isFile()); const bytes = readFileSync(target); assert.ok(files.length < 5000 && bytes.length < 32 * 1024 * 1024); files.push({ path: relative(directory, target).replaceAll('\\', '/'), bytes: bytes.length, sha256: sha(bytes) }) }
    }
  }
  visit(directory)
  return files.sort((a,b) => a.path.localeCompare(b.path))
}
const cacheBefore = inventory(optimizerCache)
if (round === 'cold') assert.equal(cacheBefore, null, 'Cold optimizer roots must be absent; never evict')
else if (phase === 'after') {
  const seed = JSON.parse(readFileSync(resolve(directory, plan.label + '-after-cold-summary.json'), 'utf8'))
  assert.equal(seed.performanceQualified, true)
  assert.equal(seed.optimizerCache, optimizerCache)
  assert.deepStrictEqual(cacheBefore, seed.cacheAfter, 'Warm seed changed before the counted command')
  assert.ok(cacheBefore.some(file => file.path.endsWith('_metadata.json')), 'Counted cold optimizer seed missing')
}
const revision = runProcessSync({ program: 'bun', args: ['--revision'], timeoutMs: 5000, maxOutputBytes: 65536 })
assert.equal(revision.code, 0); assert.equal(revision.outputTruncated, false)
const host = { platform: process.platform, arch: process.arch, nodeVersion: process.versions.node, nodeExecutable: process.execPath, bunRevision: revision.stdout.trim(), vitestVersion: JSON.parse(readFileSync('node_modules/vitest/package.json', 'utf8')).version, cpuModel: cpus()[0]?.model, totalmem: totalmem() }
assert.equal(host.platform, 'linux'); assert.equal(host.arch, 'arm64'); assert.equal(host.nodeVersion, '24.21.0'); assert.ok(host.bunRevision.startsWith('1.4.2+')); assert.equal(host.vitestVersion, '5.0.3')
const fingerprint = () => ({
  head: git(['rev-parse', 'HEAD']).trim(), diffSha256: sha(git(['diff', '--binary', 'HEAD'])),
  unrelatedDiffSha256: sha(git(['diff', '--binary', 'HEAD', '--', '.', ...Object.keys(sourceHashes).map(path => `:(exclude)${path}`)])),
  configurationSourceHashes: Object.fromEntries(Object.keys(plan.configurationSourceHashes).map(file => [file, sha(readFileSync(file))])), configSha256: sha(readFileSync(config)), reporterSha256: sha(readFileSync(reporter)), planSha256: sha(readFileSync(planPath)), harnessSha256: sha(readFileSync(import.meta.filename))
})
const before = fingerprint(); assert.equal(before.head, expectedHead, 'Unexpected frozen source head')
const freezePath = resolve(directory, `${plan.label}-benchmark-freeze.json`)
const commonFreeze = { host, configurationSourceHashes: plan.configurationSourceHashes, expectedHead, unrelatedDiffSha256: before.unrelatedDiffSha256, configSha256: before.configSha256, reporterSha256: before.reporterSha256, planSha256: before.planSha256, harnessSha256: before.harnessSha256 }
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
const label = resolve(directory, `${plan.label}-${phase}-${round}`)
assert.ok(!existsSync(label + '-summary.json'), 'Do not overwrite a counted sample')
const samples = [snapshot(null)]; assert.equal(samples[0].coordinators.length, 0, 'Another coordinator is active')
const fd = openSync(label + '.log', 'wx')
let child, closed, sampling, launchError, fdClosed = false
try {
  const start = performance.now()
  child = spawnProcess({ program: 'pnpm', args: ['exec', 'node', 'config/scripts/run-vitest.mjs', 'run', `--config=${plan.configurationByPhase[phase].path}`, ...files, '--fsModuleCache=false', `--maxWorkers=${plan.maxWorkers}`, '--sequence.shuffle', '--sequence.seed=104729', '--reporter=default', '--reporter=json', `--reporter=./${reporter}`, `--outputFile=${label}.json`],
    cwd: root, stdio: ['ignore', fd, fd],
    env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1', ORCA_ZOD_OPTIMIZER_CACHE: optimizerCache, ORCA_IMPORT_REUSE_DETAILS: label + '-details.json' } })
  closed = new Promise(done => {
    child.once('error', error => { launchError = String(error); done({ code: null, signal: null }) })
    child.once('close', (code, signal) => done({ code, signal }))
  })
  sampling = setInterval(() => { try { samples.push(snapshot(child)) } catch (error) { samples.push({ error: String(error) }) } }, 5000)
  const result = await closed
  const seconds = (performance.now() - start) / 1000
  clearInterval(sampling)
  closeSync(fd); fdClosed = true; samples.push(snapshot(child))
  const lingeringCoordinators = samples.at(-1).coordinators
  const after = fingerprint(), report = existsSync(label + '.json') ? JSON.parse(readFileSync(label + '.json', 'utf8')) : null
  const details = existsSync(label + '-details.json') ? JSON.parse(readFileSync(label + '-details.json', 'utf8')) : null
  const physicalFile = name => relative(root, name).replaceAll('\\', '/')
  const identities = report?.testResults.flatMap(module => module.assertionResults.map(test => ({ file: physicalFile(module.name), fullName: test.fullName, status: test.status, title: test.title, ancestorTitles: test.ancestorTitles })))
  const expectedIdentities = files.flatMap(file => plan.caseIdentityMapByFile[file].map(({ fullName, status, title, ancestorTitles }) => ({ file, fullName, status, title, ancestorTitles })))
  const sortCases = cases => [...cases].sort((a, b) => a.file.localeCompare(b.file) || a.fullName.localeCompare(b.fullName))
  const caseParity = identities && JSON.stringify(sortCases(identities)) === JSON.stringify(sortCases(expectedIdentities))
  const filesEqual = report?.testResults.length === files.length && JSON.stringify(report.testResults.map(module => physicalFile(module.name)).sort()) === JSON.stringify([...files].sort())
  const cacheOff = details?.rootFsModuleCache === false && details.projects.every(project => project.fsModuleCache === false)
  const setupPreserved = details?.projects.length === 3 && details.projects.every(project => project.setups.length === 6)
  const sortRoutes = routes => [...routes].sort((a,b) => a.file.localeCompare(b.file))
  const routes = details?.modules.map(({ diagnostic, ...route }) => route)
  const routePreserved = routes?.length === files.length && JSON.stringify(sortRoutes(routes)) === JSON.stringify(sortRoutes(plan.expectedModuleRoutes))
  const isolationPreserved = details?.rootIsolation === true && details.projects.every(project => project.isolate === true)
  const workerCapPreserved = details?.resolvedRootMaxWorkers === plan.maxWorkers && details.projects.every(project => project.effectiveMaxWorkers === plan.maxWorkers)
  const exactProjectsPreserved = details?.projects && JSON.stringify([...details.projects].sort((a,b) => a.name.localeCompare(b.name))) === JSON.stringify(plan.expectedProjects)
  const sourceUnchanged = JSON.stringify(before) === JSON.stringify(after)
  const external = samples.some(sample => sample.error || sample.coordinators?.some(row => !row.owned))
  const lifecycleError = /Timeout terminating|failed to terminate.*worker|worker.*termination.*timed out|Unhandled Errors/i.test(readFileSync(label + '.log', 'utf8'))
  const qualified = !launchError && lingeringCoordinators.length === 0 && !external && !lifecycleError && result?.code === 0
    && report?.success && report.numTotalTests === plan.caseCount && report.numFailedTests === 0 && caseParity && filesEqual
    && exactProjectsPreserved && cacheOff && setupPreserved && routePreserved && isolationPreserved && workerCapPreserved && sourceUnchanged && details.errors.length === 0
  const cacheAfter = inventory(optimizerCache)
  const row = { phase, round, seconds, host, optimizerCache, cacheBefore, cacheAfter, exactProjectsPreserved, command: ['pnpm', 'exec', 'node', 'config/scripts/run-vitest.mjs', 'run', `--config=${plan.configurationByPhase[phase].path}`, ...files, '--fsModuleCache=false', `--maxWorkers=${plan.maxWorkers}`, '--sequence.shuffle', '--sequence.seed=104729', '--reporter=default', '--reporter=json', `--reporter=./${reporter}`, `--outputFile=${label}.json`], result, launchError, lingeringCoordinators, external, lifecycleError,
    caseParity, filesEqual, cacheOff, setupPreserved, routePreserved, isolationPreserved, workerCapPreserved, sourceUnchanged, qualified, before, after, samples,
    noiseGuardAvailable: samples.every(sample => sample.noiseGuardAvailable), identities, details,
    configurationOnly: true, casePlanSha256: sha(readFileSync(planPath)),
    scope: 'One counted whole-pnpm-test sample; all original cohort cases, cache explicitly off, normal child close awaited. Ownership snapshots use live ancestry only; lingering coordinators are reported and never signalled.' }
  row.performanceQualified = qualified && row.noiseGuardAvailable
  writeFileSync(label + '-summary.json', JSON.stringify(row, null, 2) + '\n')
  console.log(JSON.stringify({ phase, round, seconds, qualified, caseParity, cacheOff, result }))
  assert.ok(row.performanceQualified, 'Sample lacked full performance qualification; inspect retained logs before proceeding')
  const other = resolve(directory, `${plan.label}-${phase === 'before' ? 'after' : 'before'}-${round}-summary.json`)
  if (existsSync(other)) {
    const peer = JSON.parse(readFileSync(other, 'utf8'))
    assert.ok(peer.performanceQualified)
    assert.deepStrictEqual(sortCases(peer.identities), sortCases(identities))
    assert.deepStrictEqual(peer.details.projects, details.projects, 'Resolved setup/runtime config changed')
    assert.deepStrictEqual(sortRoutes(peer.details.modules.map(({ diagnostic, ...module }) => module)), sortRoutes(routes), 'Runtime route changed')
    const control = phase === 'before' ? row : peer, candidate = phase === 'after' ? row : peer
    writeFileSync(resolve(directory, `${plan.label}-pair-${round}.json`), JSON.stringify({
      round, beforeSeconds: control.seconds, afterSeconds: candidate.seconds,
      changePct: (candidate.seconds / control.seconds - 1) * 100, exactCaseStatusAndRoutingParity: true,
      scope: 'Single pair only; all three pairs must finish before a performance claim.'
    }, null, 2) + '\n')
  }
} finally {
  clearInterval(sampling)
  if (!fdClosed) closeSync(fd)
}
