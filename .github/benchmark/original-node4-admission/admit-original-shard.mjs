import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { closeSync, existsSync, openSync, readFileSync, writeFileSync, appendFileSync, readSync, realpathSync, statSync } from 'node:fs'
import { resolve, relative, posix } from 'node:path'
import { loadavg, cpus, totalmem, arch, platform } from 'node:os'
import { pathToFileURL } from 'node:url'
import { performance } from 'node:perf_hooks'

assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Original native teardown is disposable CI only')
const root = process.cwd(), directory = resolve(import.meta.dirname)
const { runProcessSync, spawnProcess } = await import(pathToFileURL(resolve(root, 'config/scripts/script-child-process.mjs')).href)
const plan = JSON.parse(readFileSync(resolve(directory, 'admission-plan.json'), 'utf8'))
const assignment = JSON.parse(readFileSync(resolve(directory, 'assignment.json'), 'utf8'))
const shard = Number(process.argv[2])
assert.ok(Number.isInteger(shard) && shard >= 1 && shard <= 5)
const files = assignment.shards[shard - 1].files
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const git = args => {
  const result = runProcessSync({ program: 'git', args, env: { ...process.env, GIT_NO_LAZY_FETCH: '1' }, timeoutMs: 5000, maxOutputBytes: 4 * 1024 * 1024 })
  assert.equal(result.code, 0); assert.equal(result.outputTruncated, false)
  return result.stdout
}
const fingerprint = () => ({ head: git(['rev-parse', 'HEAD']).trim(), diff: sha(git(['diff', '--binary', 'HEAD'])), sources: Object.fromEntries(Object.keys(plan.sourceSha256).map(file => [file, sha(readFileSync(file))])) })
assert.equal(git(['rev-parse', 'HEAD^{tree}']).trim(), plan.sourceTree)
const before = fingerprint()
assert.equal(before.head, plan.sourceSha); assert.equal(before.diff, sha(''))
assert.deepEqual(before.sources, plan.sourceSha256)
for (const [file, expected] of Object.entries(plan.payloadSha256)) assert.equal(sha(readFileSync(resolve(directory, file))), expected)
assert.equal(process.versions.node, plan.nodeVersion)
assert.equal(JSON.parse(readFileSync('node_modules/vitest/package.json')).version, '4.1.11')
assert.equal(JSON.parse(readFileSync('package.json')).scripts.test, plan.originalTestScript)
const prefix = resolve(directory, `original-shard-${shard}`)
assert.equal(existsSync(prefix + '-summary.json'), false, 'Do not replace an admission result')
const host = { platform: platform(), arch: arch(), logicalCpus: cpus().length, cpuModel: cpus()[0]?.model, totalMemory: totalmem(), nodeVersion: process.versions.node, nodeExecutable: process.execPath, runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT, definitionSha: process.env.GITHUB_SHA }
assert.equal(host.platform, 'linux'); assert.equal(host.arch, 'arm64'); assert.equal(host.logicalCpus, 4)
const callerEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(?:ORCA_|BUN_|NODE_OPTIONS$|NODE_COMPILE_CACHE$|NODE_DISABLE_COMPILE_CACHE$|ELECTRON_RUN_AS_NODE$)/.test(key)).sort(([a], [b]) => a.localeCompare(b)))
assert.ok(!process.env.NODE_OPTIONS && !process.env.NODE_COMPILE_CACHE && !process.env.ORCA_UNIT_SELECTION_PLAN && !process.env.ORCA_SHARD_SOURCE_SHA, 'Unexpected inherited test/runtime overrides')
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

const resourceObservations = []
function readBounded(path, maximum = 1024 * 1024) {
  const fd = openSync(path, 'r'), bytes = Buffer.alloc(maximum + 1)
  let length = 0
  try {
    while (length < bytes.length) { const count = readSync(fd, bytes, length, bytes.length - length, null); if (count === 0) break; length += count }
    assert.ok(length <= maximum, `Proc/cgroup input exceeds bounded read: ${path}`)
    return bytes.subarray(0, length).toString('utf8')
  } finally { closeSync(fd) }
}
const events = text => Object.fromEntries(['oom', 'oom_kill'].map(key => {
  const value = text.match(new RegExp(`^${key} (\\d+)$`, 'm'))?.[1]
  assert.ok(value !== undefined, `Missing cgroup counter: ${key}`)
  return [key, value]
}))
const decodeMount = value => value.replace(/\\([0-7]{3})/g, (_, digits) => String.fromCharCode(parseInt(digits, 8)))
const fileIdentity = path => { const stat = statSync(path, { bigint: true }); return { dev: String(stat.dev), ino: String(stat.ino) } }
const cgroupPreflightInputs = {}
function resolveCgroup() {
  const membershipRaw = readBounded('/proc/self/cgroup')
  cgroupPreflightInputs.membershipRaw = membershipRaw
  const entries = membershipRaw.split('\n').filter(line => line.startsWith('0::'))
  assert.equal(entries.length, 1, 'One visible cgroupv2 membership required')
  const membership = decodeMount(entries[0].slice(3))
  assert.ok(membership.startsWith('/') && !membership.split('/').includes('..'))
  const mountInfo = readBounded('/proc/self/mountinfo')
  cgroupPreflightInputs.mountLines = mountInfo.split('\n').filter(line => line.split(' - ')[1]?.split(' ')[0] === 'cgroup2')
  const mounts = mountInfo.split('\n').flatMap(line => {
    const parts = line.split(' - '); if (parts.length !== 2 || parts[1].split(' ')[0] !== 'cgroup2') return []
    const fields = parts[0].split(' '), mountRoot = decodeMount(fields[3]), mountPoint = decodeMount(fields[4])
    if (!mountRoot || !mountPoint || !mountRoot.startsWith('/') || !mountPoint.startsWith('/')) return []
    if (membership !== mountRoot && mountRoot !== '/' && !membership.startsWith(mountRoot + '/')) return []
    const inside = posix.relative(mountRoot, membership)
    if (inside.startsWith('../') || posix.isAbsolute(inside)) return []
    const realMount = realpathSync(mountPoint), group = realpathSync(resolve(realMount, inside))
    const relativeGroup = relative(realMount, group)
    assert.ok(!relativeGroup.startsWith('../') && !posix.isAbsolute(relativeGroup), 'Group escaped the cgroupv2 mount')
    const procs = resolve(group, 'cgroup.procs')
    if (!readBounded(procs).trim().split(/\s+/).includes(String(process.pid))) return []
    return [{ ownerPid: process.pid, membershipRaw, membership, mountRoot, mountPoint, mountLine: line, realMount, group, procs, current: resolve(group, 'memory.current'), memoryEvents: resolve(group, 'memory.events'), groupIdentity: fileIdentity(group) }]
  }).sort((a,b) => b.mountRoot.length - a.mountRoot.length || a.mountPoint.localeCompare(b.mountPoint))
  assert.ok(mounts.length > 0, 'No visible cgroupv2 mount contains the current process')
  const binding = mounts[0]
  binding.currentIdentity = fileIdentity(binding.current); binding.eventsIdentity = fileIdentity(binding.memoryEvents)
  const current = readBounded(binding.current).trim(); assert.match(current, /^\d+$/)
  events(readBounded(binding.memoryEvents))
  return binding
}
let cgroupBinding
try {
  cgroupBinding = resolveCgroup()
  writeFileSync(prefix + '-resource-preflight.json', JSON.stringify({ qualified: true, binding: cgroupBinding, inputs: cgroupPreflightInputs }, null, 2) + '\n', { flag: 'wx' })
} catch (error) {
  writeFileSync(prefix + '-resource-preflight.json', JSON.stringify({ qualified: false, reason: String(error), inputs: cgroupPreflightInputs, testChildLaunched: false }, null, 2) + '\n', { flag: 'wx' })
  throw error
}
function resources(heldChild) {
  assert.equal(readBounded('/proc/self/cgroup'), cgroupBinding.membershipRaw, 'Current process cgroup changed')
  assert.ok(readBounded('/proc/self/mountinfo').split('\n').includes(cgroupBinding.mountLine), 'Bound cgroupv2 mount changed')
  assert.deepEqual(fileIdentity(cgroupBinding.group), cgroupBinding.groupIdentity)
  assert.deepEqual(fileIdentity(cgroupBinding.current), cgroupBinding.currentIdentity)
  assert.deepEqual(fileIdentity(cgroupBinding.memoryEvents), cgroupBinding.eventsIdentity)
  assert.ok(readBounded(cgroupBinding.procs).trim().split(/\s+/).includes(String(process.pid)), 'Sampler left its bound cgroup')
  const processRows = runProcessSync({ program: 'ps', args: ['-axo', 'pid=,ppid=,rss=,command='], timeoutMs: 5000, maxOutputBytes: 2 * 1024 * 1024 })
  assert.equal(processRows.code, 0); assert.equal(processRows.outputTruncated, false)
  const rows = processRows.stdout.split('\n').flatMap(line => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/)
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), rssKiB: Number(match[3]), command: match[4] }] : []
  })
  const cgroupCurrent = readBounded(cgroupBinding.current).trim(); assert.match(cgroupCurrent, /^\d+$/)
  const cgroupEvents = readBounded(cgroupBinding.memoryEvents)
  const record = { timestamp: new Date().toISOString(), binding: cgroupBinding, childHeld: Boolean(heldChild && heldChild.exitCode === null && heldChild.signalCode === null), processes: rows.sort((a,b) => b.rssKiB-a.rssKiB).slice(0, 15), memory: readBounded('/proc/meminfo'), cgroupCurrent, cgroupEvents, eventCounters: events(cgroupEvents) }
  resourceObservations.push(record)
  appendFileSync(prefix + '-resources.jsonl', JSON.stringify(record) + '\n')
  console.log(JSON.stringify({ resourceObservation: record.timestamp, highestRssKiB: record.processes[0]?.rssKiB, cgroupCurrent: record.cgroupCurrent, eventCounters: record.eventCounters }))
}
const samples = [snapshot(null)]
assert.equal(samples[0].coordinators.length, 0, 'Another coordinator is active')
const fd = openSync(prefix + '.log', 'wx')
let child, sampling, fdClosed = false, launchError
const argv = ['exec', 'vitest', 'run', '--config', 'config/vitest.config.ts', `--shard=${shard}/5`, '--maxWorkers=4', '--reporter=default', '--reporter=json', '--reporter=./config/scripts/ci-unit-timing-reporter.mjs', '--reporter=./.github/benchmark/original-node4-admission/admission-reporter.mjs', `--outputFile=${prefix}.json`]
resources(null)
const startedAt = new Date().toISOString(), start = performance.now()
try {
  child = spawnProcess({ program: 'pnpm', args: argv, cwd: root, stdio: ['ignore', fd, fd], env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1', ORCA_BALANCE_UNIT_SHARDS: '1', ORCA_SHARD_SOURCE_SHA: plan.sourceSha, ORCA_UNIT_SELECTION_PLAN: resolve(directory, 'selection.json'), ORCA_SHARD_MANIFEST: prefix + '-assignment.json', ORCA_UNIT_TIMING_REPORT: prefix + '-timings.json', ORCA_ORIGINAL_ADMISSION_DETAILS: prefix + '-details.json' } })
  const closed = new Promise(done => { child.once('error', error => { launchError = String(error); done({ code: null, signal: null }) }); child.once('close', (code, signal) => done({ code, signal })) })
  sampling = setInterval(() => { try { samples.push(snapshot(child)); resources(child) } catch (error) { samples.push({ error: String(error) }) } }, 5000)
  const result = await closed
  clearInterval(sampling); closeSync(fd); fdClosed = true
  samples.push(snapshot(child)); resources(child)
  const after = fingerprint()
  const optional = suffix => existsSync(prefix + suffix) ? JSON.parse(readFileSync(prefix + suffix, 'utf8')) : null
  const report = optional('.json'), details = optional('-details.json'), actualAssignment = optional('-assignment.json'), timings = optional('-timings.json')
  const actualFiles = report?.testResults.map(module => relative(root, module.name).replaceAll('\\', '/')).sort()
  const rawCases = report?.testResults.flatMap(module => module.assertionResults.map((test, assertionIndex) => ({ assertionIndex, file: relative(root, module.name).replaceAll('\\', '/'), fullName: test.fullName, title: test.title, ancestorTitles: test.ancestorTitles, status: test.status })))
  const errors = []
  const check = (value, message) => { if (!value) errors.push(message) }
  const initialOom = resourceObservations[0].eventCounters
  check(resourceObservations.length >= 2 && resourceObservations.every(record => Object.entries(record.eventCounters).every(([key,value]) => value === initialOom[key]) && JSON.stringify(record.binding) === JSON.stringify(cgroupBinding)), 'Observed OOM counter change or resource binding drift')
  check(!launchError && result.code === 0 && result.signal === null, 'Process did not close successfully')
  check(JSON.stringify(before) === JSON.stringify(after), 'Original source changed')
  check(JSON.stringify(actualFiles) === JSON.stringify([...files].sort()), 'Physical shard coverage differs')
  check(report?.success && report.numFailedTests === 0 && report.numTotalTests === rawCases?.length, 'Raw case/error summary failed')
  check(rawCases?.every(row => ['passed', 'pending', 'todo', 'skipped'].includes(row.status)), 'Unknown or failed case status')
  check(new Set(rawCases?.map(row => JSON.stringify([row.file, row.assertionIndex]))).size === rawCases?.length, 'Raw assertion ordinal collision; retain duplicate natural titles without rewriting them')
  check(details?.reason === 'passed' && details.errors.length === 0, 'Reporter failure/unhandled error')
  check(details?.rootIsolation === true && details.resolvedRootMaxWorkers === 4 && details.experimentalFsModuleCache === false, 'Original stock isolation/cap/cache changed')
  check(details?.projects.length === 1 && details.projects.every(project => project.pool === 'forks' && project.effectiveMaxWorkers === 4 && project.isolate === true && project.experimentalFsModuleCache === false && project.testTimeout === 30000 && project.hookTimeout === 60000 && JSON.stringify(project.execArgv) === JSON.stringify(plan.execArgv) && JSON.stringify(project.setups) === JSON.stringify(plan.setupFiles)), 'Original V4 project/setup/flags changed')
  check(details?.modules.length === files.length && details.modules.every(module => module.pool === 'forks' && ['passed', 'skipped'].includes(module.state)) && JSON.stringify(details.modules.map(module => module.file).sort()) === JSON.stringify([...files].sort()), 'Actual Node-forks module routes/states differ')
  check(actualAssignment?.sourceSha === plan.sourceSha && actualAssignment.selectedShard === shard && actualAssignment.baselineSha256 === assignment.baselineSha256 && JSON.stringify(actualAssignment.shards) === JSON.stringify(assignment.shards), 'Original authoritative LPT map differs')
  check(timings?.status === 'passed' && timings.unhandledErrors === 0 && Object.values(timings.results).every(state => ['passed', 'skipped'].includes(state)) && JSON.stringify(Object.keys(timings.results).sort()) === JSON.stringify([...files].sort()), 'Original timing reporter coverage/state differs')
  check(samples.every(sample => !sample.error && sample.noiseGuardAvailable && sample.coordinators.every(row => row.owned)) && samples.at(-1).coordinators.length === 0, 'External coordinator or unverified lingering coordinator')
  check(!/Timeout terminating|failed to terminate.*worker|worker.*termination.*timed out|Unhandled Errors/i.test(readFileSync(prefix + '.log', 'utf8')), 'Lifecycle or unhandled-error log marker')
  const summary = { classification: 'Original-source correctness/resource admission only, not a timing/adoption result', qualified: errors.length === 0, errors, sourceRoot: root, sourceSha: plan.sourceSha, host, callerEnv, argv, startedAt, finishedAt: new Date().toISOString(), observedSeconds: (performance.now()-start)/1000, result, launchError, before, after, files, rawCases, details, actualAssignment, samples, lingeringCoordinators: samples.at(-1).coordinators, lifecycleError: /Timeout terminating|failed to terminate.*worker|worker.*termination.*timed out|Unhandled Errors/i.test(readFileSync(prefix + '.log', 'utf8')), planSha256: sha(readFileSync(resolve(directory, 'admission-plan.json'))), payloadSha256: plan.payloadSha256, cgroupBinding, resourceSha256: sha(readFileSync(prefix + '-resources.jsonl')) }
  writeFileSync(prefix + '-summary.json', JSON.stringify(summary, null, 2) + '\n')
  assert.ok(summary.qualified, 'Original reference failed admission; retain raw failure, do not repair or time it')
} finally { clearInterval(sampling); if (!fdClosed) closeSync(fd) }
