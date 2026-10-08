import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, openSync, closeSync } from 'node:fs'
import { loadavg } from 'node:os'
import { resolve, relative } from 'node:path'
import { performance } from 'node:perf_hooks'
import { spawnProcess, runProcessSync } from '../../../config/scripts/script-child-process.mjs'

const [phase, roundArgument, planArgument = 'notes/bun-migration/performance/automation-six-suite-benchmark-plan.json'] = process.argv.slice(2)
assert.ok(['before', 'after'].includes(phase), 'Pass before|after and round0|1|2; root applies/reverts the patch between invocations')
assert.ok(['0', '1', '2'].includes(roundArgument), 'Round must be0,1or2; every round counts')
const round = Number(roundArgument)
const root = process.cwd(), directory = resolve('notes/bun-migration/performance')
const planPath = resolve(planArgument)
const plan = JSON.parse(readFileSync(planPath, 'utf8'))
assert.match(plan.label, /^[a-z][a-z0-9-]*$/, 'Use a bounded artifact label')
const sha = value => createHash('sha256').update(value).digest('hex')
const files = plan.filesByPhase[phase]
const git = args => {
  const r = runProcessSync({ program: 'git', args, env: { ...process.env, GIT_NO_LAZY_FETCH: '1' }, timeoutMs: 5000, maxOutputBytes: 2 * 1024 * 1024 })
  assert.equal(r.code, 0); assert.equal(r.outputTruncated, false)
  return r.stdout
}
const sourceHashes = phase === 'before' ? plan.sourceBeforeSha256 : plan.sourceAfterSha256
const sourceHashReceipt = {}
for (const [path, expected] of Object.entries(sourceHashes)) {
  if (expected === null) assert.equal(existsSync(path), false, `${phase} deleted source exists: ${path}`)
  else assert.equal(sha(readFileSync(path)), expected, `${phase} source changed: ${path}`)
  sourceHashReceipt[path] = expected === null ? null : sha(readFileSync(path))
}
assert.equal(sha(readFileSync(plan.patch)), plan.patchSha256, 'Ignored patch changed')
for (const [file, hash] of Object.entries(plan.identityProofFiles)) assert.equal(sha(readFileSync(file)), hash, 'Original case proof changed')
const expectedHead = process.env.ORCA_IMPORT_REUSE_BENCH_EXPECTED_HEAD ?? plan.sourceHead
const config = 'config/vitest.config.ts'
const reporter = 'notes/bun-migration/performance/persistence-import-reuse-benchmark-reporter.mjs'
const fingerprint = () => ({
  head: git(['rev-parse', 'HEAD']).trim(), diffSha256: sha(git(['diff', '--binary', 'HEAD'])),
  unrelatedDiffSha256: sha(git(['diff', '--binary', 'HEAD', '--', '.', ...Object.keys(sourceHashes).map(path => `:(exclude)${path}`)])),
  configSha256: sha(readFileSync(config)), reporterSha256: sha(readFileSync(reporter)), planSha256: sha(readFileSync(planPath)), harnessSha256: sha(readFileSync(import.meta.filename))
})
const before = fingerprint(); assert.equal(before.head, expectedHead, 'Unexpected frozen source head')
const freezePath = resolve(directory, `${plan.label}-benchmark-freeze.json`)
const commonFreeze = { expectedHead, unrelatedDiffSha256: before.unrelatedDiffSha256, configSha256: before.configSha256, reporterSha256: before.reporterSha256, planSha256: before.planSha256, harnessSha256: before.harnessSha256 }
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
  const launchArgs = ['test', ...files, '--fsModuleCache=true', `--maxWorkers=${plan.maxWorkers}`, '--reporter=json', `--reporter=./${reporter}`, `--outputFile=${label}.json`]
  child = spawnProcess({ program: 'pnpm', args: launchArgs,
    cwd: root, stdio: ['ignore', fd, fd],
    env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1', ORCA_IMPORT_REUSE_DETAILS: label + '-details.json' } })
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
  const expectedIdentities = files.flatMap(file => plan.caseIdentityMapByPhase[phase][file].map(({ fullName, status, title, ancestorTitles }) => ({ file, fullName, status, title, ancestorTitles })))
  const tuple = ({ file, fullName, status, title, ancestorTitles }) => [file, fullName, status, title, ancestorTitles]
  const sortCases = cases => cases.map(tuple).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  const retainedCases = cases => {
    const remaining = [...cases]
    for (const { multiplicity, ...removed } of plan.removedCases) {
      assert.ok(Number.isInteger(multiplicity) && multiplicity > 0)
      for (let i = 0; i < multiplicity; i++) {
        const index = remaining.findIndex(row => JSON.stringify(tuple(row)) === JSON.stringify(tuple(removed)))
        assert.ok(index >= 0, 'Approved deletion missing from original raw map')
        remaining.splice(index, 1)
      }
    }
    return remaining
  }
  const caseParity = identities && JSON.stringify(sortCases(identities)) === JSON.stringify(sortCases(expectedIdentities))
  const filesEqual = report?.testResults.length === files.length && JSON.stringify(report.testResults.map(module => physicalFile(module.name)).sort()) === JSON.stringify([...files].sort())
  const cacheEnabled = details?.rootFsModuleCache === true && details.projects.every(project => project.fsModuleCache === true)
  const setupPreserved = details?.projects.length === 3 && details.projects.every(project => project.setups.length === 6)
  const sortRoutes = routes => [...routes].sort((a,b) => a.file.localeCompare(b.file))
  const routes = details?.modules.map(({ diagnostic, ...route }) => route)
  const routePreserved = routes?.length === files.length && JSON.stringify(sortRoutes(routes)) === JSON.stringify(sortRoutes(plan.expectedModuleRoutesByPhase[phase]))
  const isolationPreserved = details?.rootIsolation === true && details.projects.every(project => project.isolate === true)
  const workerCapPreserved = details?.resolvedRootMaxWorkers === plan.maxWorkers && details.projects.every(project => project.effectiveMaxWorkers === plan.maxWorkers)
  const sourceUnchanged = JSON.stringify(before) === JSON.stringify(after)
  const external = samples.some(sample => sample.error || sample.coordinators?.some(row => !row.owned))
  const lifecycleError = /Timeout terminating|failed to terminate.*worker|worker.*termination.*timed out|Unhandled Errors/i.test(readFileSync(label + '.log', 'utf8'))
  const qualified = !launchError && lingeringCoordinators.length === 0 && !external && !lifecycleError && result?.code === 0
    && report?.success && report.numTotalTests === plan.caseCountByPhase[phase] && report.numFailedTests === 0 && caseParity && filesEqual
    && report.testResults.every(module => module.assertionResults.length > 0)
    && cacheEnabled && setupPreserved && routePreserved && isolationPreserved && workerCapPreserved && sourceUnchanged && details.errors.length === 0
  const row = { phase, round, seconds, result, command: ['pnpm', ...launchArgs], launchError, lingeringCoordinators, external, lifecycleError,
    caseParity, filesEqual, cacheEnabled, setupPreserved, routePreserved, isolationPreserved, workerCapPreserved, sourceUnchanged, qualified, sourceHashReceipt, before, after, samples,
    noiseGuardAvailable: samples.every(sample => sample.noiseGuardAvailable), identities, details,
    patchSha256: plan.patchSha256, casePlanSha256: sha(readFileSync(planPath)),
    scope: 'One counted whole-pnpm-test sample; fixed phase-specific full raw map differs only reviewed17 deletions. Shipping fs cache explicitly on, normal child close awaited. Live ancestry only; lingering coordinators reported and never signalled.' }
  row.performanceQualified = qualified && row.noiseGuardAvailable
  writeFileSync(label + '-summary.json', JSON.stringify(row, null, 2) + '\n')
  console.log(JSON.stringify({ phase, round, seconds, qualified, caseParity, cacheEnabled, result }))
  assert.ok(row.performanceQualified, 'Sample lacked full performance qualification; inspect retained logs before proceeding')
  const other = resolve(directory, `${plan.label}-${phase === 'before' ? 'after' : 'before'}-${round}-summary.json`)
  if (existsSync(other)) {
    const peer = JSON.parse(readFileSync(other, 'utf8'))
    assert.ok(peer.performanceQualified)
    const original = phase === 'before' ? identities : peer.identities
    const candidateCases = phase === 'after' ? identities : peer.identities
    assert.deepStrictEqual(sortCases(retainedCases(original)), sortCases(candidateCases))
    assert.deepStrictEqual(peer.details.projects, details.projects, 'Resolved setup/runtime config changed')
    const originalRoutes = phase === 'before' ? routes : peer.details.modules.map(({ diagnostic, ...module }) => module)
    const candidateRoutes = phase === 'after' ? routes : peer.details.modules.map(({ diagnostic, ...module }) => module)
    assert.deepStrictEqual(sortRoutes(originalRoutes.filter(row => !plan.wholeFilesRemoved.includes(row.file))), sortRoutes(candidateRoutes), 'Retained runtime route changed')
    const control = phase === 'before' ? row : peer, candidate = phase === 'after' ? row : peer
    writeFileSync(resolve(directory, `${plan.label}-pair-${round}.json`), JSON.stringify({
      round, beforeSeconds: control.seconds, afterSeconds: candidate.seconds,
      changePct: (candidate.seconds / control.seconds - 1) * 100, exactApprovedDeletionCaseStatusAndRetainedRoutingParity: true,
      scope: 'Single pair only; all three pairs must finish before a performance claim.'
    }, null, 2) + '\n')
  }
} finally {
  clearInterval(sampling)
  if (!fdClosed) closeSync(fd)
}
