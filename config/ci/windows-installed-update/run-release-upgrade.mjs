/** Released Electron-hosted daemon -> Bun candidate -> released rollback, then the release's uninstall. */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { runProcess } from '../../../src/shared/child-process/run-process.ts'
import { canAttach } from './daemon-protocol-facts.mjs'
import { ELECTRON_DAEMON_IDENTITY_FILES, hashFile } from './installed-layout.mjs'
import {
  authenticode,
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
  status: 'running',
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
  // Source-derived expectations: what each build's legacy discovery can reach.
  designAttach: {
    candidateReachesReleaseOwned: canAttach(protocols.candidate, protocols.release),
    releaseReachesCandidateOwned: canAttach(protocols.release, protocols.candidate)
  },
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
function check(name, ok, detail = {}) {
  receipt.checks.push({ name, ok, ...detail })
  if (!ok) {
    throw new Error(`Check failed: ${name}`)
  }
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
function sentinelsPresent(when, names = Object.keys(sentinels)) {
  for (const name of names) {
    check(`sentinel ${name} ${when}`, existsSync(sentinels[name]))
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
  const installer = join(inputs.candidate, 'orca-windows-setup.exe')
  const result = await runInstaller(installer, ['--updated'], candidate, candidate.identity)
  installLocation = result.location
  receipt.installs.push({ label: 'candidate', ...result })
}
function readPidRecord(protocolVersion) {
  const path = join(profile, 'daemon', `daemon-v${protocolVersion}.pid`)
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}
async function electronOwner(stage) {
  const record = readPidRecord(protocols.release.protocolVersion)
  check(`${stage}: release daemon pid record present`, Number.isSafeInteger(record?.pid))
  check(
    `${stage}: release daemon reports the release version`,
    record.appVersion === release.version,
    { appVersion: record.appVersion }
  )
  const table = await processTable()
  const row = table?.find((candidateRow) => candidateRow.pid === record.pid)
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
  owned.daemons.push(owner)
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
// A session the running app cannot route is a finding; name it instead of timing out anonymously.
async function reach(stage, item, owner, attachable) {
  try {
    return await terminals.observe(item)
  } catch (error) {
    check(`${stage}: ${owner.kind}-owned session reachable after the transition`, false, {
      error: error.message,
      designAttachable: attachable,
      ownerLive: processVerdict(await processTable(), owner)
    })
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

try {
  const preexisting = [hostRoot, legacyRoot, join(localAppData, 'Programs', 'Orca')].filter(
    (path) => existsSync(path)
  )
  check('runner has no prior Orca install or daemon host', preexisting.length === 0)
  plant(sentinels.unrelated)

  // Release: the Electron-hosted daemon users run today.
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

  // Upgrade with release-owned sessions live.
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
  for (const item of live) {
    await reach('candidate', item, released, receipt.designAttach.candidateReachesReleaseOwned)
  }
  // daemon-pty-router.ts: fresh sessions always route to the current daemon.
  const fresh = await terminals.terminal(worktrees.git)
  await terminals.observe(fresh, true)
  const bunFirst = await bunOwner('candidate fresh admission')
  await expectOwnedBy('candidate fresh admission', fresh, bunFirst)
  await preserved('candidate fresh admission', [released], live)
  await terminals.close(fresh)
  receipt.stages.push({ stage: 'candidate with release-owned sessions', released, bun: bunFirst })

  // Drain: both owners retire once idle and unattached (daemon-server-lifecycle.ts).
  for (const item of live) {
    await terminals.close(item)
  }
  receipt.stages.push({ stage: 'candidate drain', remaining: await terminals.closeAll(worktrees) })
  await stopServe(serve)
  serve = null
  for (const owner of [released, bunFirst]) {
    check(
      `candidate drain: ${owner.kind} owner exited`,
      (await waitVerdict(owner, 'exited', 60_000)) === 'exited'
    )
  }
  serve = await startServe(installLocation, profile, env)
  const bunLive = await terminals.terminal(worktrees.folder)
  await terminals.observe(bunLive, true)
  const bunOwned = await bunOwner('candidate after drain')
  check('candidate after drain: owner is a new process', !sameProcess(bunOwned, bunFirst))
  await expectOwnedBy('candidate after drain', bunLive, bunOwned)
  // daemon-host-relocation.ts pruneOldDaemonHosts reclaims unowned legacy host versions.
  check('drained release host reclaimed', await waitAbsent(legacyHost))
  sentinelsPresent('after drain')

  // Rollback to the release with a candidate-owned session live.
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
  const rollbackFresh = await terminals.terminal(worktrees.git)
  await terminals.observe(rollbackFresh, true)
  const releasedAgain = await electronOwner('rollback fresh admission')
  await expectOwnedBy('rollback fresh admission', rollbackFresh, releasedAgain)
  await preserved('rollback fresh admission', [bunOwned], [bunLive])
  receipt.stages.push({ stage: 'rollback', bun: bunOwned, released: releasedAgain })

  // The release's own uninstaller, with both owners live.
  await stopServe(serve)
  serve = null
  await preserved('before uninstall', [bunOwned, releasedAgain], [bunLive, rollbackFresh])
  const location = installLocation
  receipt.uninstall = await runUninstaller()
  installLocation = null
  for (const [name, identity] of [
    ['release daemon', releasedAgain],
    ['release shell', rollbackFresh.shell],
    ['Bun daemon', bunOwned],
    ['Bun shell', bunLive.shell]
  ]) {
    check(`uninstall ends ${name}`, (await waitVerdict(identity, 'exited', 60_000)) === 'exited')
  }
  const table = await processTable()
  check('post-uninstall process table verifiable', Boolean(table))
  check(
    'no process runs from install dir or either daemon host',
    processesUnder(table, [location, legacyRoot, hostRoot]).length === 0
  )
  check('legacy Electron host root removed', !existsSync(legacyRoot))
  check('managed runtime namespace removed', !existsSync(hostRoot))
  check('unrelated LOCALAPPDATA content untouched', existsSync(sentinels.unrelated))
  check(
    'folder workspace contents untouched',
    readFileSync(join(root, 'folder', 'keep.txt'), 'utf8') === 'keep\n'
  )
  receipt.status = 'passed'
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
      receipt.cleanup.push(`stopped surviving ${owner.kind} owner`)
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
