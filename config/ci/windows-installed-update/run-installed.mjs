/** Windows installed lifecycle: A -> B -> A across Bun runtime generations, then genuine uninstall. */
import { randomBytes } from 'node:crypto'
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { runProcess, spawnProcess } from '../../../src/shared/child-process/run-process.ts'
import { hashFile } from './installed-layout.mjs'
import {
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
  generationOfImage,
  isGenerationName,
  managedRootFor,
  processVerdict,
  processesUnder
} from './windows-evidence.mjs'

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
const inputs = { A: required('--input-a'), B: required('--input-b') }
const tools = { rpc: required('--rpc'), retire: required('--retire') }
const receiptPath = required('--receipt')
const builds = {
  A: JSON.parse(readFileSync(join(inputs.A, 'build-receipt.json'), 'utf8')),
  B: JSON.parse(readFileSync(join(inputs.B, 'build-receipt.json'), 'utf8'))
}
const localAppData = realpathSync(process.env.LOCALAPPDATA ?? '')
const orcaLocal = join(localAppData, 'Orca')
const hostRoot = join(orcaLocal, 'terminal-daemon-host')
const managedRoot = managedRootFor(localAppData)
const root = realpathSync(mkdtempSync(join(tmpdir(), 'owq-')))
const profile = join(root, 'profile')
const env = serveEnvironment(profile, localAppData)
const receipt = {
  scope: 'unsigned diagnostic installers; NSIS argv of NsisUpdater install-on-quit; headless serve',
  status: 'running',
  arch: builds.A.arch,
  versions: { A: builds.A.version, B: builds.B.version },
  bun: { A: builds.A.bunSha256, B: builds.B.bunSha256 },
  installs: [],
  stages: [],
  retention: [],
  checks: [],
  cleanup: []
}
const sentinels = {
  unrelated: join(orcaLocal, 'unrelated-sentinel', 'keep.txt'),
  legacyHostFile: join(orcaLocal, 'daemon-host', 'legacy-sentinel.txt'),
  hostSibling: join(hostRoot, 'legacy-sentinel', 'keep.txt'),
  managedNonGeneration: join(managedRoot, 'not-a-generation', 'keep.txt')
}
let serve = null
let installLocation = null
let pinner = null
const owned = { daemons: [], shells: [] }

function check(name, ok, detail = {}) {
  receipt.checks.push({ name, ok, ...detail })
  if (!ok) {
    throw new Error(`Check failed: ${name}`)
  }
}
async function install(label, extra) {
  const result = await runInstaller(
    join(inputs[label], 'orca-windows-setup.exe'),
    extra,
    builds[label],
    builds[label].identity
  )
  installLocation = result.location
  receipt.installs.push({ label, ...result })
}
async function daemon() {
  const { identity } = await nodeTool(tools.rpc, ['identity', profile], env)
  const row = await identify(identity.pid)
  check('daemon process identity verifiable', Boolean(row?.exe), { pid: identity.pid })
  const generation = generationOfImage(row.exe, managedRoot)
  check('daemon image is a managed runtime generation', Boolean(generation), { pid: identity.pid })
  return { ...identity, created: row.created, command: row.command, generation }
}
const sameOwner = (a, b) =>
  a.pid === b.pid &&
  a.startedAtMs === b.startedAtMs &&
  a.launchNonce === b.launchNonce &&
  a.created === b.created
async function expectGeneration(owner, label) {
  check(
    `${label} daemon runs ${label} Bun bytes`,
    (await hashFile(join(managedRoot, owner.generation, 'bun-runtime.exe'))) ===
      builds[label].bunSha256,
    { generation: owner.generation }
  )
  if (owner.appVersion) {
    check(`${label} daemon reports ${label} version`, owner.appVersion === builds[label].version)
  }
  // The fork runs the relocated copy; the reported identity keeps the installed entry for freshness checks.
  const relocatedEntry = join(managedRoot, owner.generation, 'daemon-entry.js')
  check(
    `${label} daemon runs the entry inside its generation`,
    Boolean(owner.command?.toLowerCase().includes(relocatedEntry.toLowerCase())),
    { command: owner.command, relocatedEntry }
  )
  if (owner.entryPath) {
    const installedEntry = join(installLocation, 'resources', 'terminal-daemon', 'daemon-entry.js')
    check(
      `${label} daemon reports the installed entry`,
      owner.entryPath.toLowerCase() === installedEntry.toLowerCase(),
      { entryPath: owner.entryPath, installedEntry }
    )
  }
}
async function terminal(worktreeId) {
  const handle = (
    await cli(serve, env, [
      'terminal',
      'create',
      '--worktree',
      worktreeId,
      '--shell',
      'powershell.exe'
    ])
  ).terminal.handle
  return { handle, worktreeId, memory: randomBytes(12).toString('hex') }
}
// The split nonce keeps echoed input from satisfying the match; $PID proves the same shell process.
async function observe(item, first = false) {
  await cli(serve, env, ['terminal', 'show', '--terminal', item.handle])
  const nonce = randomBytes(12).toString('hex')
  const text = `${first ? `$env:ORCA_TRANSITION_MEMORY='${item.memory}'; ` : ''}Write-Output ('${nonce.slice(0, 12)}'+'${nonce.slice(12)}:'+$PID+':'+$env:ORCA_TRANSITION_MEMORY)`
  await cli(serve, env, ['terminal', 'send', '--terminal', item.handle, '--text', text, '--enter'])
  const deadline = Date.now() + 45_000
  while (Date.now() < deadline) {
    const tail = (
      (await cli(serve, env, ['terminal', 'read', '--terminal', item.handle]))?.terminal?.tail ?? []
    )
      .map(String)
      .join('\n')
    const match = tail.match(new RegExp(`${nonce}:([0-9]+):${item.memory}(?:\\r?\\n|$)`))
    if (match) {
      const pid = Number(match[1])
      if (item.shell && item.shell.pid !== pid) {
        throw new Error('Shell PID changed')
      }
      if (!item.shell) {
        item.shell = await identify(pid)
        check('shell identity verifiable', Boolean(item.shell?.created))
        owned.shells.push(item.shell)
      } else {
        check(
          'same shell process (pid + creation time)',
          processVerdict(await processTable(), item.shell) === 'live'
        )
      }
      return { shellPid: pid, liveMemoryMatched: true, freshOutputMatched: true }
    }
    await delay(500)
  }
  throw new Error('Live shell nonce/memory verification timed out')
}
async function close(item) {
  await cli(serve, env, ['terminal', 'close', '--terminal', item.handle])
  if (item.shell) {
    check('closed terminal shell exited', (await waitVerdict(item.shell, 'exited')) === 'exited')
  }
}
async function transitionTo(label, owner, live) {
  await stopServe(serve)
  serve = null
  const before = await processTable()
  check(`owner survives serve stop before ${label}`, processVerdict(before, owner) === 'live')
  for (const item of live) {
    check('shell survives serve stop', processVerdict(before, item.shell) === 'live')
  }
  await install(label, ['--updated'])
  const after = await processTable()
  check(`owner survives installing ${label}`, processVerdict(after, owner) === 'live')
  for (const item of live) {
    check(`shell survives installing ${label}`, processVerdict(after, item.shell) === 'live')
  }
  check(
    `${label} install keeps running generation`,
    existsSync(join(managedRoot, owner.generation, 'bun-runtime.exe'))
  )
  sentinelsPresent(`after installing ${label}`)
  serve = await startServe(installLocation, profile, env)
}
async function continuity(stage, owner, live, worktreeId) {
  const current = await daemon()
  check(`${stage}: daemon owner preserved`, sameOwner(owner, current))
  const terminals = []
  for (const item of live) {
    terminals.push(await observe(item))
  }
  const fresh = await terminal(worktreeId)
  terminals.push({ fresh: true, ...(await observe(fresh, true)) })
  check(`${stage}: fresh admission joins preserved owner`, sameOwner(owner, await daemon()))
  await close(fresh)
  receipt.stages.push({ stage, owner: current, terminals })
}
// Pre-PTY stale-bundle replacement is darwin-only (resolvePackagedDarwinAppVersion); on Windows a
function descendantsOf(table, pid) {
  const found = []
  const frontier = [pid]
  while (frontier.length > 0) {
    const parent = frontier.pop()
    for (const row of table) {
      if (row.ppid === parent && !found.some((seen) => seen.pid === row.pid)) {
        found.push(row)
        frontier.push(row.pid)
      }
    }
  }
  return found.map((row) => ({
    pid: row.pid,
    ppid: row.ppid,
    name: row.name,
    command: row.command?.slice(0, 300)
  }))
}
const ptyHostCount = (table, owner) =>
  table.filter((row) => row.ppid === owner.pid && /^bun-runtime\.exe$/iu.test(row.name)).length
// A killed terminal must release its per-terminal PTY host, or the daemon can never idle out.
async function expectHostReleased(stage, owner, item) {
  const before = await processTable()
  const hosts = before ? ptyHostCount(before, owner) : null
  await close(item)
  const deadline = Date.now() + 30_000
  let after = null
  while (Date.now() < deadline) {
    after = await processTable()
    if (after && hosts !== null && ptyHostCount(after, owner) === hosts - 1) {
      break
    }
    await delay(500)
  }
  const released = Boolean(after && hosts !== null && ptyHostCount(after, owner) === hosts - 1)
  check(
    `${stage}: closed terminal releases its PTY host`,
    released,
    released
      ? {}
      : { hostsBefore: hosts, tree: after ? descendantsOf(after, owner.pid) : 'unverifiable' }
  )
}
// Why: a daemon only idles out with zero sessions and zero clients; name what is still attached.
async function drainEvidence(verdict, ownerPid) {
  const table = await processTable()
  const survivors = (table ? processesUnder(table, [installLocation, managedRoot]) : []).map(
    (row) => ({ pid: row.pid, ppid: row.ppid, name: row.name, command: row.command?.slice(0, 400) })
  )
  const logs = join(profile, 'logs')
  const daemonLog = existsSync(join(logs, 'daemon.log'))
    ? readFileSync(join(logs, 'daemon.log'), 'utf8').slice(-6000)
    : null
  return {
    verdict,
    snapshot: table ? 'complete' : 'unverifiable',
    survivors,
    ownerTree: table ? descendantsOf(table, ownerPid) : 'unverifiable',
    logFiles: existsSync(logs) ? readdirSync(logs) : [],
    daemonLog
  }
}
// drained owner self-retires when its last client leaves, so the next launch is the only prune.
async function switchGeneration(stage, owner, live, worktreeId, label) {
  for (const item of live) {
    await close(item)
  }
  await stopServe(serve)
  serve = null
  const drained = await waitVerdict(owner, 'exited', 60_000)
  check(
    `${stage}: drained owner exited before relaunch`,
    drained === 'exited',
    drained === 'exited' ? {} : await drainEvidence(drained, owner.pid)
  )
  serve = await startServe(installLocation, profile, env)
  const item = await terminal(worktreeId)
  await observe(item, true)
  const current = await daemon()
  check(`${stage}: first admission after drain uses a new owner`, !sameOwner(owner, current))
  await expectGeneration(current, label)
  owned.daemons.push(current)
  receipt.stages.push({ stage, replacedOwner: owner, owner: current })
  return { owner: current, item }
}
function sentinelsPresent(when) {
  for (const [name, path] of Object.entries(sentinels)) {
    check(`sentinel ${name} ${when}`, existsSync(path))
  }
}
function plant(path) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, 'keep\n')
}
// Four decoy generations, oldest first; the oldest is pinned by a live process image.
function plantDecoys(source) {
  const decoys = []
  for (let age = 4; age >= 1; age--) {
    const name = `bun-${randomBytes(32).toString('hex')}`
    const directory = join(managedRoot, name)
    mkdirSync(directory)
    copyFileSync(join(managedRoot, source, 'bun-runtime.exe'), join(directory, 'bun-runtime.exe'))
    if (existsSync(join(managedRoot, source, 'conpty'))) {
      cpSync(join(managedRoot, source, 'conpty'), join(directory, 'conpty'), { recursive: true })
    }
    const when = new Date(Date.now() - age * 86_400_000)
    utimesSync(directory, when, when)
    decoys.push(name)
  }
  pinner = spawnProcess({
    program: join(managedRoot, decoys[0], 'bun-runtime.exe'),
    args: ['-e', 'setInterval(() => {}, 1 << 30)'],
    stdio: 'ignore'
  })
  return decoys
}
async function expectRetention(stage, present, absent) {
  const deadline = Date.now() + 90_000
  let names = []
  while (Date.now() < deadline) {
    names = readdirSync(managedRoot).filter(
      (name) => isGenerationName(name) || name.startsWith('.bun-')
    )
    if (
      present.every((name) => names.includes(name)) &&
      absent.every((name) => !names.includes(name)) &&
      !names.some((name) => name.startsWith('.bun-'))
    ) {
      break
    }
    await delay(1_000)
  }
  receipt.retention.push({ stage, observed: names, present, absent })
  for (const name of present) {
    check(`${stage}: ${name.slice(0, 16)} retained`, names.includes(name))
  }
  for (const name of absent) {
    check(`${stage}: ${name.slice(0, 16)} pruned`, !names.includes(name))
  }
  check(`${stage}: no staging or trash left`, !names.some((name) => name.startsWith('.bun-')))
}
async function seedWorkspaces() {
  const worktrees = {}
  for (const kind of ['git', 'folder']) {
    const path = join(root, kind)
    mkdirSync(path)
    writeFileSync(join(path, 'keep.txt'), 'keep\n')
    let repo
    if (kind === 'git') {
      for (const argv of [
        ['init', '-b', 'main'],
        ['config', 'user.name', 'Orca Test'],
        ['config', 'user.email', 'test@orca.test'],
        ['add', '.'],
        ['commit', '-m', 'seed']
      ]) {
        if ((await runProcess({ program: 'git', args: argv, cwd: path })).code !== 0) {
          throw new Error(`git ${argv[0]} failed`)
        }
      }
      repo = (await cli(serve, env, ['repo', 'add', '--path', path])).repo
    } else {
      repo = (
        await nodeTool(tools.rpc, ['folder', profile, path], {
          ...env,
          ORCA_PAIRING_CODE: serve.pairing
        })
      ).repo
      check(
        'folder stays a folder workspace',
        repo.kind === 'folder' && !existsSync(join(path, '.git'))
      )
    }
    worktrees[kind] = (
      await cli(serve, env, [
        'worktree',
        'create',
        '--repo',
        `id:${repo.id}`,
        '--name',
        `lifecycle-${kind}`,
        '--setup',
        'skip'
      ])
    ).worktree.id
  }
  return worktrees
}

try {
  const preexisting = [hostRoot, join(localAppData, 'Programs', 'Orca')].filter((path) =>
    existsSync(path)
  )
  check('runner has no prior Orca install or runtime host', preexisting.length === 0)
  plant(sentinels.unrelated)
  await install('A', [])
  serve = await startServe(installLocation, profile, env)
  const worktrees = await seedWorkspaces()
  const live = [await terminal(worktrees.git), await terminal(worktrees.folder)]
  const firstEvidence = []
  for (const item of live) {
    firstEvidence.push(await observe(item, true))
  }
  const ownerA = await daemon()
  await expectGeneration(ownerA, 'A')
  owned.daemons.push(ownerA)
  receipt.stages.push({ stage: 'A', owner: ownerA, terminals: firstEvidence })
  // Control before any update: separates a general kill-path leak from an update-specific one.
  const control = await terminal(worktrees.git)
  await observe(control, true)
  await expectHostReleased('A (before update)', ownerA, control)
  for (const path of [
    sentinels.legacyHostFile,
    sentinels.hostSibling,
    sentinels.managedNonGeneration
  ]) {
    plant(path)
  }

  await transitionTo('B', ownerA, live)
  await continuity('B (A-owned sessions)', ownerA, live, worktrees.git)
  const decoys = plantDecoys(ownerA.generation)
  const pinned = await identify(pinner.pid)
  check('decoy pin process verifiable', Boolean(pinned?.created))
  const switchedB = await switchGeneration(
    'B (new generation)',
    ownerA,
    live,
    worktrees.folder,
    'B'
  )
  check('B generation differs from A', switchedB.owner.generation !== ownerA.generation)
  check('decoy pin still live at B launch', processVerdict(await processTable(), pinned) === 'live')
  await expectRetention(
    'after B launch',
    [ownerA.generation, switchedB.owner.generation, decoys[0], decoys[3]],
    [decoys[1], decoys[2]]
  )
  sentinelsPresent('after B generation launch')

  await transitionTo('A', switchedB.owner, [switchedB.item])
  await continuity(
    'A2 rollback (B-owned session)',
    switchedB.owner,
    [switchedB.item],
    worktrees.git
  )
  const switchedA = await switchGeneration(
    'A2 (rollback generation)',
    switchedB.owner,
    [switchedB.item],
    worktrees.git,
    'A'
  )
  check(
    'rollback reuses the immutable A generation',
    switchedA.owner.generation === ownerA.generation
  )
  await expectRetention(
    'after rollback launch',
    [ownerA.generation, switchedB.owner.generation, decoys[0], decoys[3]],
    [decoys[1], decoys[2]]
  )
  sentinelsPresent('after rollback')

  await stopServe(serve)
  serve = null
  const beforeUninstall = await processTable()
  check(
    'owner survives final serve stop',
    processVerdict(beforeUninstall, switchedA.owner) === 'live'
  )
  const uninstall = await runUninstaller()
  const location = installLocation
  installLocation = null
  receipt.uninstall = { ...uninstall }
  for (const [name, identity] of [
    ['daemon', switchedA.owner],
    ['shell', switchedA.item.shell],
    ['decoy pin', pinned]
  ]) {
    check(
      `uninstall ends owned ${name}`,
      (await waitVerdict(identity, 'exited', 60_000)) === 'exited'
    )
  }
  const table = await processTable()
  check('post-uninstall process table verifiable', Boolean(table))
  check(
    'no process runs from install dir or runtime host',
    processesUnder(table, [location, hostRoot]).length === 0
  )
  check('managed runtime namespace removed', !existsSync(hostRoot))
  check('legacy Electron host root removed', !existsSync(join(orcaLocal, 'daemon-host')))
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
  if (pinner && pinner.exitCode === null) {
    pinner.kill()
    receipt.cleanup.push('decoy pin process signalled')
  }
  try {
    await runProcess({
      program: process.execPath,
      args: [tools.retire, profile],
      env,
      timeoutMs: 20_000
    })
    const table = await processTable()
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
