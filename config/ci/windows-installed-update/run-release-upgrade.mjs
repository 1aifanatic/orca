/** Released Electron-hosted daemon -> Bun candidate, then either candidate uninstall or rollback + release uninstall. */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { runProcess } from '../../../src/shared/child-process/run-process.ts'
import { canAttach, crossingRequirements } from './daemon-protocol-facts.mjs'
import { ELECTRON_DAEMON_IDENTITY_FILES, hashFile } from './installed-layout.mjs'
import {
  authenticode,
  cli,
  identify,
  nodeTool,
  processTable,
  runInstaller,
  runUninstaller,
  serveEnvironment,
  startServe,
  stopServe,
  waitVerdict
} from './lifecycle-host.mjs'
import {
  descendantsOf,
  generationOfImage,
  isRelocatedElectronDaemon,
  managedRootFor,
  processVerdict,
  processesUnder
} from './windows-evidence.mjs'
import { createWorkspaceTerminals } from './workspace-terminals.mjs'

const args = new Map(
  process.argv
    .slice(2)
    .map((arg) => [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)])
)
const required = (key) => {
  const value = args.get(key)
  if (!value) {
    throw new Error(`Required: ${key}=...`)
  }
  return resolve(value)
}
const lane = args.get('--lane')
if (!['rollback-uninstall', 'candidate-uninstall'].includes(lane ?? '')) {
  throw new Error('Required: --lane=rollback-uninstall|candidate-uninstall')
}
if (
  process.platform !== 'win32' ||
  process.env.GITHUB_ACTIONS !== 'true' ||
  process.env.RUNNER_ENVIRONMENT !== 'github-hosted'
) {
  throw new Error(
    'Requires a disposable GitHub-hosted Windows runner: installs per-user and uses the real LOCALAPPDATA'
  )
}
const inputs = { release: required('--release'), candidate: required('--candidate') }
const tools = { rpc: required('--rpc'), retire: required('--retire') }
const receiptPath = required('--receipt')
const release = JSON.parse(readFileSync(join(inputs.release, 'release-receipt.json'), 'utf8'))
const candidate = JSON.parse(readFileSync(join(inputs.candidate, 'build-receipt.json'), 'utf8'))
const protocols = {
  release: release.daemonProtocol,
  candidate: JSON.parse(readFileSync(join(inputs.candidate, 'daemon-protocol.json'), 'utf8'))
}
const localAppData = realpathSync(process.env.LOCALAPPDATA ?? '')
const orcaLocal = join(localAppData, 'Orca')
const legacyRoot = join(orcaLocal, 'daemon-host')
const legacyHost = join(legacyRoot, release.version)
const hostRoot = join(orcaLocal, 'terminal-daemon-host')
const managedRoot = managedRootFor(localAppData)
const root = realpathSync(mkdtempSync(join(tmpdir(), 'owr-')))
const profile = join(root, 'profile')
const env = serveEnvironment(profile, localAppData)
const receipt = {
  scope: 'signed public release -> unsigned Bun candidate via NsisUpdater argv; headless serve',
  lane,
  status: 'running',
  // Strict failures that later stages were allowed to run past; the verdict is still FAIL.
  mode: 'diagnostic-continue',
  firstFailure: null,
  release: {
    tag: release.tag,
    version: release.version,
    sha256: release.sha256,
    signer: release.signer
  },
  candidate: {
    source: candidate.source,
    version: candidate.version,
    bunSha256: candidate.bunSha256
  },
  protocols,
  designAttach: {
    candidateReachesReleaseOwned: canAttach(protocols.candidate, protocols.release),
    releaseReachesCandidateOwned: canAttach(protocols.release, protocols.candidate)
  },
  crossingRequirements: crossingRequirements(protocols.release),
  installs: [],
  stages: [],
  checks: [],
  cleanup: []
}
const sentinels = {
  unrelated: join(orcaLocal, 'unrelated-sentinel', 'keep.txt'),
  legacyHostFile: join(legacyRoot, 'legacy-sentinel.txt'),
  hostSibling: join(hostRoot, 'legacy-sentinel', 'keep.txt')
}
let serve = null
let installLocation = null
let releaseIdentity = null
const owned = { daemons: [], shells: [] }
function record(name, ok, detail, continued) {
  receipt.checks.push({ name, ok, ...(continued && !ok ? { continued: true } : {}), ...detail })
  if (!ok) {
    receipt.firstFailure ??= name
  }
}
function check(name, ok, detail = {}) {
  record(name, ok, detail, false)
  if (!ok) {
    throw new Error(`Check failed: ${name}`)
  }
}
/** A strict assertion whose failure is recorded, after which the run keeps collecting evidence. */
function expectThenContinue(name, ok, detail = {}) {
  record(name, ok, detail, true)
  return ok
}
const terminals = createWorkspaceTerminals({
  root,
  profile,
  env,
  tools,
  check,
  owned,
  session: () => serve
})
const sameProcess = (a, b) => a.pid === b.pid && a.created === b.created
function plant(path) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, 'keep\n')
}
function sentinelsPresent(when) {
  for (const [name, path] of Object.entries(sentinels)) {
    check(`sentinel ${name} ${when}`, existsSync(path))
  }
}
async function installRelease(extra) {
  const installer = join(inputs.release, 'orca-windows-setup.exe')
  const result = await runInstaller(
    installer,
    extra,
    { label: 'release', version: release.version },
    releaseIdentity,
    ELECTRON_DAEMON_IDENTITY_FILES
  )
  releaseIdentity ??= result.identity
  const signature = await authenticode(join(result.location, 'Orca.exe'))
  check(
    'installed release executable carries the release signature',
    signature.status === 'Valid' && signature.thumbprint === release.signer.thumbprint,
    { signature }
  )
  installLocation = result.location
  receipt.installs.push({ label: 'release', ...result })
}
async function installCandidate() {
  const result = await runInstaller(
    join(inputs.candidate, 'orca-windows-setup.exe'),
    ['--updated'],
    candidate,
    candidate.identity
  )
  installLocation = result.location
  receipt.installs.push({ label: 'candidate', ...result })
}
function endpointFiles(protocolVersion) {
  const base = join(profile, 'daemon', `daemon-v${protocolVersion}`)
  let pid = null
  try {
    pid = JSON.parse(readFileSync(`${base}.pid`, 'utf8'))
  } catch {
    // Absent or unreadable is recorded as null.
  }
  return { pid, token: existsSync(`${base}.token`) }
}
async function electronOwner(stage) {
  const { pid: record } = endpointFiles(protocols.release.protocolVersion)
  check(`${stage}: release daemon pid record present`, Number.isSafeInteger(record?.pid))
  check(
    `${stage}: release daemon reports the release version`,
    record.appVersion === release.version,
    { appVersion: record.appVersion }
  )
  const row = (await processTable())?.find((candidateRow) => candidateRow.pid === record.pid)
  check(
    `${stage}: release daemon runs the relocated Electron host`,
    isRelocatedElectronDaemon(row, legacyHost),
    { exe: row?.exe, command: row?.command?.slice(0, 400), legacyHost }
  )
  const owner = {
    kind: 'electron',
    pid: record.pid,
    startedAtMs: record.startedAtMs,
    appVersion: record.appVersion,
    created: row.created,
    exe: row.exe
  }
  if (!owned.daemons.some((known) => sameProcess(known, owner))) {
    owned.daemons.push(owner)
  }
  return owner
}
async function bunOwner(stage) {
  const { identity } = await nodeTool(
    tools.rpc,
    ['identity', profile, String(protocols.candidate.protocolVersion)],
    env
  )
  const row = await identify(identity.pid)
  const generation = row?.exe ? generationOfImage(row.exe, managedRoot) : null
  check(`${stage}: candidate daemon runs a managed Bun generation`, Boolean(generation), {
    exe: row?.exe
  })
  check(
    `${stage}: candidate daemon runs candidate Bun bytes`,
    (await hashFile(join(managedRoot, generation, 'bun-runtime.exe'))) === candidate.bunSha256
  )
  const owner = { kind: 'bun', ...identity, created: row.created, exe: row.exe, generation }
  owned.daemons.push(owner)
  return owner
}
async function expectOwnedBy(stage, item, owner) {
  const table = await processTable()
  const tree = table ? descendantsOf(table, owner.pid) : []
  check(
    `${stage}: shell runs under the expected ${owner.kind} owner`,
    tree.some((row) => row.pid === item.shell.pid),
    { owner: owner.pid, shell: item.shell.pid }
  )
}
async function reach(stage, item, owner, attachable) {
  try {
    await terminals.observe(item)
    return expectThenContinue(
      `${stage}: ${owner.kind}-owned session reachable after the transition`,
      true
    )
  } catch (error) {
    return expectThenContinue(
      `${stage}: ${owner.kind}-owned session reachable after the transition`,
      false,
      {
        error: error.message,
        designAttachable: attachable,
        ownerVerdict: processVerdict(await processTable(), owner),
        shellVerdict: processVerdict(await processTable(), item.shell)
      }
    )
  }
}
async function preserved(stage, owners, items) {
  const table = await processTable()
  for (const owner of owners) {
    check(
      `${stage}: ${owner.kind} owner live (pid + creation time)`,
      processVerdict(table, owner) === 'live'
    )
  }
  for (const item of items) {
    check(
      `${stage}: shell live (pid + creation time)`,
      processVerdict(table, item.shell) === 'live'
    )
  }
}
async function waitAbsent(path, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  while (existsSync(path) && Date.now() < deadline) {
    await delay(1_000)
  }
  return !existsSync(path)
}
// Why: the release owner's endpoint must be proven live, not inferred, before calling its sessions orphaned.
async function orphanEvidence(owner, worktrees) {
  const files = endpointFiles(protocols.release.protocolVersion)
  let endpoint = null
  try {
    endpoint = (
      await nodeTool(
        tools.rpc,
        ['identity', profile, String(protocols.release.protocolVersion)],
        env
      )
    ).identity
  } catch (error) {
    endpoint = { error: error.message }
  }
  const listed = {}
  for (const workspace of Object.values(worktrees)) {
    try {
      const result = await cli(serve, env, ['terminal', 'list', '--worktree', workspace])
      listed[workspace] = (result?.terminals ?? []).map((entry) => entry.handle)
    } catch (error) {
      listed[workspace] = { error: error.message }
    }
  }
  return {
    releaseProtocol: protocols.release.protocolVersion,
    candidateProtocol: protocols.candidate.protocolVersion,
    candidateProbesUpTo: Math.max(...protocols.candidate.previousProtocolVersions),
    pidRecord: files.pid,
    tokenPresent: files.token,
    endpointAnswers: endpoint,
    endpointIsOwner: endpoint?.pid === owner.pid,
    ownerVerdict: processVerdict(await processTable(), owner),
    candidateListsHandles: listed
  }
}
async function uninstallFindings(owners, items) {
  await stopServe(serve)
  serve = null
  await preserved('before uninstall', owners, items)
  const location = installLocation
  const uninstall = await runUninstaller()
  installLocation = null
  const verdicts = []
  for (const identity of [...owners, ...items.map((item) => item.shell)]) {
    const verdict = await waitVerdict(identity, 'exited', 60_000)
    verdicts.push({ kind: identity.kind ?? 'shell', pid: identity.pid, verdict })
    expectThenContinue(
      `uninstall ends ${identity.kind ?? 'shell'} ${identity.pid}`,
      verdict === 'exited'
    )
  }
  const table = await processTable()
  check('post-uninstall process table verifiable', Boolean(table))
  const survivors = processesUnder(table, [location, legacyRoot, hostRoot]).map((row) => ({
    pid: row.pid,
    name: row.name,
    exe: row.exe
  }))
  const remainingDirs = [location, legacyRoot, hostRoot, managedRoot]
    .filter((path) => existsSync(path))
    .map((path) => ({ path, entries: readdirSync(path).slice(0, 20) }))
  receipt.uninstall = { lane, ...uninstall, verdicts, survivors, remainingDirs }
  expectThenContinue(
    'no process runs from install dir or either daemon host',
    survivors.length === 0
  )
  expectThenContinue('legacy Electron host root removed', !existsSync(legacyRoot))
  expectThenContinue('managed runtime namespace removed', !existsSync(hostRoot))
  check('unrelated LOCALAPPDATA content untouched', existsSync(sentinels.unrelated))
  check(
    'folder workspace contents untouched',
    readFileSync(join(root, 'folder', 'keep.txt'), 'utf8') === 'keep\n'
  )
}

try {
  const preexisting = [hostRoot, legacyRoot, join(localAppData, 'Programs', 'Orca')].filter(
    (path) => existsSync(path)
  )
  check('runner has no prior Orca install or daemon host', preexisting.length === 0)
  plant(sentinels.unrelated)

  await installRelease([])
  serve = await startServe(installLocation, profile, env)
  const worktrees = await terminals.seedWorkspaces()
  const live = [await terminals.terminal(worktrees.git), await terminals.terminal(worktrees.folder)]
  for (const item of live) {
    await terminals.observe(item, true)
  }
  const released = await electronOwner('release')
  for (const item of live) {
    await expectOwnedBy('release', item, released)
  }
  plant(sentinels.legacyHostFile)
  plant(sentinels.hostSibling)
  receipt.stages.push({ stage: 'release', owner: released, shells: live.map((item) => item.shell) })

  await stopServe(serve)
  serve = null
  await preserved('release serve stopped', [released], live)
  await installCandidate()
  await preserved('candidate installed', [released], live)
  check(
    'candidate install keeps the running release host',
    existsSync(join(legacyHost, 'Orca.exe'))
  )
  sentinelsPresent('after candidate install')
  serve = await startServe(installLocation, profile, env)
  const reachable = []
  for (const item of live) {
    if (
      await reach('candidate', item, released, receipt.designAttach.candidateReachesReleaseOwned)
    ) {
      reachable.push(item)
    }
  }
  const orphaned = live.filter((item) => !reachable.includes(item))
  if (orphaned.length > 0) {
    receipt.stages.push({
      stage: 'candidate orphaned release sessions',
      evidence: await orphanEvidence(released, worktrees)
    })
  }
  // daemon-pty-router.ts: fresh sessions always route to the current daemon.
  const fresh = await terminals.terminal(worktrees.git)
  await terminals.observe(fresh, true)
  const bunFirst = await bunOwner('candidate fresh admission')
  await expectOwnedBy('candidate fresh admission', fresh, bunFirst)
  await preserved('candidate fresh admission', [released], live)
  await terminals.close(fresh)

  // Drain: an owner retires once idle and unattached (daemon-server-lifecycle.ts).
  for (const item of reachable) {
    await terminals.close(item)
  }
  try {
    receipt.stages.push({
      stage: 'candidate drain',
      remaining: await terminals.closeAll(worktrees)
    })
  } catch (error) {
    expectThenContinue('candidate drain: every workspace terminal closes', false, {
      error: error.message
    })
  }
  await stopServe(serve)
  serve = null
  check(
    'candidate drain: idle Bun owner exited',
    (await waitVerdict(bunFirst, 'exited', 60_000)) === 'exited'
  )
  const releaseRetired = (await waitVerdict(released, 'exited', 60_000)) === 'exited'
  expectThenContinue('candidate drain: release owner retired', releaseRetired, {
    orphanedSessions: orphaned.length
  })
  serve = await startServe(installLocation, profile, env)
  const bunLive = await terminals.terminal(worktrees.folder)
  await terminals.observe(bunLive, true)
  const bunOwned = await bunOwner('candidate after drain')
  check('candidate after drain: owner is a new process', !sameProcess(bunOwned, bunFirst))
  await expectOwnedBy('candidate after drain', bunLive, bunOwned)
  // daemon-host-relocation.ts pruneOldDaemonHosts reclaims legacy hosts no live pid record pins.
  expectThenContinue('drained release host reclaimed', await waitAbsent(legacyHost), {
    releaseOwnerRetired: releaseRetired
  })
  sentinelsPresent('after drain')
  const stillReleaseOwned = releaseRetired ? [] : orphaned

  if (lane === 'candidate-uninstall') {
    await uninstallFindings(
      [bunOwned, ...(releaseRetired ? [] : [released])],
      [bunLive, ...stillReleaseOwned]
    )
  } else {
    await stopServe(serve)
    serve = null
    await preserved('candidate serve stopped', [bunOwned], [bunLive])
    await installRelease(['--updated'])
    await preserved('release reinstalled', [bunOwned], [bunLive])
    check(
      'rollback keeps the running Bun generation',
      existsSync(join(managedRoot, bunOwned.generation, 'bun-runtime.exe'))
    )
    sentinelsPresent('after rollback install')
    serve = await startServe(installLocation, profile, env)
    await reach('rollback', bunLive, bunOwned, receipt.designAttach.releaseReachesCandidateOwned)
    // A same-version, still-healthy release owner is adopted again (daemon-replacement-preflight.ts).
    for (const item of stillReleaseOwned) {
      await reach('rollback (release-owned)', item, released, true)
    }
    const rollbackFresh = await terminals.terminal(worktrees.git)
    await terminals.observe(rollbackFresh, true)
    const current = await electronOwner('rollback fresh admission')
    if (!releaseRetired) {
      expectThenContinue(
        'rollback fresh admission joins the surviving release owner',
        sameProcess(current, released)
      )
    }
    await expectOwnedBy('rollback fresh admission', rollbackFresh, current)
    receipt.stages.push({ stage: 'rollback', bun: bunOwned, release: current })
    const owners = [
      bunOwned,
      current,
      ...(releaseRetired || sameProcess(current, released) ? [] : [released])
    ]
    await uninstallFindings(owners, [bunLive, rollbackFresh, ...stillReleaseOwned])
  }
  receipt.status = receipt.firstFailure ? 'failed' : 'passed'
} catch (error) {
  receipt.status = 'failed'
  receipt.error = error instanceof Error ? error.message : String(error)
} finally {
  if (serve) {
    try {
      await stopServe(serve)
      receipt.cleanup.push('serving process exited')
    } catch (error) {
      receipt.cleanup.push(error.message)
      receipt.status = 'failed'
    }
  }
  try {
    await runProcess({
      program: process.execPath,
      args: [tools.retire, profile],
      env,
      timeoutMs: 20_000
    })
    // Only identities this run recorded (pid + creation time) are stopped; never by image name.
    let table = await processTable()
    for (const owner of owned.daemons.filter(
      (identity) => processVerdict(table, identity) === 'live'
    )) {
      await runProcess({
        program: join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
        args: ['/PID', String(owner.pid), '/T', '/F']
      })
      receipt.cleanup.push(`stopped surviving ${owner.kind} owner ${owner.pid}`)
    }
    table = await processTable()
    const survivors = [...owned.daemons, ...owned.shells].filter(
      (identity) => processVerdict(table, identity) !== 'exited'
    )
    receipt.cleanup.push(
      survivors.length
        ? `${survivors.length} owned processes live or unverifiable`
        : 'all owned daemons and shells exited'
    )
    if (survivors.length) {
      receipt.status = 'failed'
    }
  } catch (error) {
    receipt.cleanup.push(`cleanup verification failed: ${error.message}`)
    receipt.status = 'failed'
  }
  if (installLocation) {
    receipt.cleanup.push('install retained after failure on a disposable runner')
  }
  mkdirSync(dirname(receiptPath), { recursive: true })
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`)
}
process.exitCode = receipt.status === 'passed' ? 0 : 1
