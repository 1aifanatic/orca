import { compareAppVersions } from '../../../src/shared/app-version.ts'
import { parse as parseYaml } from 'yaml'
import { dirname } from 'node:path'
import { createReadinessQueue } from './readiness-queue.mjs'
/** Diagnostic signed-build updater: one stable installation, native replacement and rollback. */
import { spawn } from 'node:child_process'
import { randomBytes, createHash } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, realpathSync, copyFileSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { resolveRuntimeServeSmokeLaunch, readRuntimeServeSmokePid, runtimeServeSmokeProcessState } from '../../../config/scripts/runtime-serve-smoke-launch.mjs'
import { summarizeCommandFailure } from '../mac-app-transition-qualification/command-failure.mjs'
import { PROTOCOL_VERSION } from '../../../src/main/daemon/daemon-protocol-version.ts'
import { stopServer } from '../../../config/scripts/runtime-serve-smoke-shutdown.mjs'

const args = new Map(process.argv.slice(2).map(arg => { const i = arg.indexOf('='); return [arg.slice(0, i), arg.slice(i + 1)] }))
const required = key => { const value = args.get(key); if (!value) throw new Error(`Required: ${key}=...`); return resolve(value) }
if (process.platform !== 'darwin' || process.env.CI !== 'true' || process.env.ORCA_ISOLATED_CI_USER !== '1') {
  throw new Error('Requires an isolated macOS CI user; this changes the user default keychain')
}
const source = resolve(import.meta.dirname, '../../..')
const appA = required('--app-a'), appB = required('--app-b'), receiptPath = required('--receipt')
const probe = required('--probe'), cleanup = required('--cleanup'), folderRpc = required('--folder-rpc')
const root = realpathSync(mkdtempSync(join(tmpdir(), 'oui-')))
const manifests = { A: required('--manifest-a'), B: required('--manifest-b') }
const updaterControl = required('--updater-control')
const selectionSecret = randomBytes(32).toString('hex')
let readiness, currentVersion, installInFlight = false
const profile = join(root, 'profile')
const receipt = { scope: 'native signed diagnostic-build installed update and downgrade; no renderer or Bun-generation claim', status: 'running', root, stages: [], cleanup: [], commandFailures: [] }
let child, launch, pairing, command, servingPid, serverReady = false, cancelled = false, cleaning = false
const auxiliaries = new Set()
const observedShells = new Set()
const cancel = () => { cancelled = true; if (!cleaning) for (const child of auxiliaries) child.kill('SIGKILL') }
process.on('SIGTERM', cancel)
process.on('SIGINT', cancel)
const totalTimer = setTimeout(cancel, 25 * 60_000)
function check() { if (cancelled) throw new Error('Qualification cancelled or total deadline reached') }
function run(program, argv, options = {}) {
  if (!options.cleanup) check()
  return new Promise((resolvePromise, reject) => {
    const proc = spawn(program, argv, { cwd: options.cwd ?? source, env: { ...process.env, ...launch?.env, ORCA_PAIRING_CODE: options.pairing, ORCA_BACKGROUND_LAUNCH: '1' }, stdio: ['ignore', 'pipe', 'pipe'] })
    auxiliaries.add(proc)
    let output = '', stderr = '', size = 0, failure
    const timer = setTimeout(() => { failure = 'command timeout'; proc.kill('SIGKILL') }, options.timeout ?? 30_000)
    proc.stdout.on('data', data => { size += data.length; if (size > 2 ** 20) { failure = 'command output cap'; proc.kill('SIGKILL') } else output += data })
    proc.stderr.on('data', data => { size += data.length; if (size <= 2 ** 20) stderr += data; if (options.captureStderr && size <= 2 ** 20) output += data; if (size > 2 ** 20) { failure = 'command output cap'; proc.kill('SIGKILL') } })
    proc.once('error', () => { failure = 'command spawn failed' })
    proc.once('close', (code, signal) => {
      clearTimeout(timer); auxiliaries.delete(proc)
      if (failure || code !== 0) {
        const evidence = { operation: options.label ?? 'diagnostic command', ...summarizeCommandFailure(output, stderr, code, signal, failure) }
        receipt.commandFailures.push(evidence)
        reject(new Error(`${evidence.operation}: ${failure ?? `exit ${code}`}${evidence.errorCode ? ` (${evidence.errorCode})` : ''}`))
      }
      else resolvePromise(output.trim())
    })
  })
}
async function cli(argv) {
  const data = JSON.parse(await run(command, [...argv, '--pairing-code', pairing, '--json'], { label: `CLI ${argv[0]} ${argv[1]}` }))
  if (!data.ok) throw new Error(`CLI ${argv[0]} ${argv[1]} refused (${data.error?.code ?? 'unknown'})`)
  return data.result
}
async function hash(path) {
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(path)) digest.update(chunk)
  return digest.digest('hex')
}
async function availablePort() {
  const socket = createServer()
  await new Promise((resolvePromise, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', resolvePromise) })
  const port = socket.address().port
  await new Promise(resolvePromise => socket.close(resolvePromise))
  return port
}
async function start(app) {
  check()
  serverReady = false
  command = join(app, 'Contents/Resources/bin/orca')
  child = spawn(command, launch.args, { env: { ...process.env, ...launch.env }, stdio: ['ignore', 'pipe', 'pipe'] })
  readiness = createReadinessQueue(child, { cancelled: () => cancelled })
  await acceptReady(await readiness.next())
}
async function acceptReady(ready) {
  pairing = new URL(ready.pairing.url).searchParams.get('code')
  if (!pairing) throw new Error('Replacement has no pairing code')
  servingPid = readRuntimeServeSmokePid(profile)
  if (!servingPid) throw new Error('Replacement has no serving identity')
  serverReady = true
}
async function updater(action) {
  return JSON.parse(await run(process.execPath, [updaterControl, profile, action], { pairing, label: `Updater ${action}` }))
}
async function waitUpdaterReady(version) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    check()
    const snapshot = await updater('status')
    receipt.updaterInitialization = { requestedVersion: version, appVersion: snapshot.appVersion, support: snapshot.support, state: snapshot.status?.state }
    if (snapshot.appVersion !== version) throw new Error('Serving updater version mismatch')
    if (snapshot.support?.installMode === 'supervised-headless-serve' && snapshot.support.automatic) return snapshot
    await delay(250)
  }
  throw new Error('Supervised updater initialization timeout')
}
async function waitStatus(state, version, timeout = 180_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    check()
    const snapshot = await updater('status')
    const observation = { requestedState: state, requestedVersion: version, appVersion: snapshot.appVersion, support: snapshot.support, status: snapshot.status }
    receipt.lastUpdaterObservation = observation
    receipt.updaterTransitions ??= []
    const previous = receipt.updaterTransitions.at(-1)
    if (!previous || JSON.stringify(previous.observation) !== JSON.stringify(observation)) {
      if (receipt.updaterTransitions.length >= 32) receipt.updaterTransitions.shift()
      receipt.updaterTransitions.push({ observedAt: new Date().toISOString(), observation })
    }
    if (snapshot.support?.installMode !== 'supervised-headless-serve' || !snapshot.support.automatic) throw new Error('Production updater supervisor unavailable')
    if (snapshot.status.state === 'error') throw new Error('Production updater reported failure')
    if (snapshot.status.state === state && snapshot.status.version === version) return snapshot
    const responsePath = join(root, 'update-response.json')
    if (existsSync(responsePath) && JSON.parse(readFileSync(responsePath, 'utf8')).phase === 'refused') throw new Error('Diagnostic selection refused')
    await delay(250)
  }
  throw new Error(`Updater ${state} timeout`)
}
async function transition(label, installed) {
  const version = receipt[label].version
  if (version === currentVersion) throw new Error('Same-version install cannot qualify replacement')
  const id = randomBytes(16).toString('hex')
  const request = join(root, 'update-request.json')
  writeFileSync(`${request}.tmp`, JSON.stringify({ id, secret: selectionSecret, manifest: join(root, 'feeds', label, 'latest-mac.yml'), fromVersion: currentVersion, targetVersion: version }), { mode: 0o600, flag: 'wx' })
  renameSync(`${request}.tmp`, request)
  await waitStatus('available', version)
  const selection = JSON.parse(readFileSync(join(root, 'update-response.json'), 'utf8'))
  if (selection.id !== id || selection.phase !== 'selected' || selection.targetVersion !== version) throw new Error('Local selection receipt mismatch')
  await updater('download')
  await waitStatus('downloaded', version, 300_000)
  const oldServingPid = servingPid
  installInFlight = true
  const accepted = await updater('install')
  if (!accepted.accepted || accepted.fromVersion !== currentVersion || accepted.targetVersion !== version) throw new Error('Install acceptance mismatch')
  await acceptReady(await readiness.next(180_000))
  if (servingPid === oldServingPid || runtimeServeSmokeProcessState(oldServingPid) !== 'exited') throw new Error('Old serving process did not exit')
  if (child.exitCode !== null || child.signalCode !== null) throw new Error('Original supervisor did not survive install')
  const actual = await run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', join(installed, 'Contents/Info.plist')])
  if (actual !== version) throw new Error('Stable slot does not contain requested version')
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', installed])
  for (const [field, relative] of [['appAsarSha256', 'Contents/Resources/app.asar'], ['cliEntrySha256', 'Contents/Resources/app.asar.unpacked/out/cli/index.js'], ['executableSha256', 'Contents/MacOS/Orca'], ['bunSha256', 'Contents/Resources/cli-runtime/bun-runtime'], ['daemonEntrySha256', 'Contents/Resources/terminal-daemon/daemon-entry.js']]) {
    if (await hash(join(installed, relative)) !== receipt[label][field]) throw new Error('Installed signed artifact hash mismatch')
  }
  const snapshot = await waitUpdaterReady(version)
  if (snapshot.appVersion !== version) throw new Error('Replacement runtime version mismatch')
  receipt.installs ??= []
  receipt.installs.push({ fromVersion: currentVersion, targetVersion: version, oldServingPid, servingPid, supervisorPid: child.pid, stableSlotVerified: true, signedHashesMatched: true })
  currentVersion = version
  installInFlight = false
}
async function stop() {
  if (!child) return
  // PID comes only from this fresh profile; stopServer checks launcher and serving process exit.
  await stopServer(child, undefined, false, servingPid ?? readRuntimeServeSmokePid(profile))
  child = undefined; servingPid = undefined; pairing = undefined
  if (!serverReady) throw new Error('Startup never established serving identity; profile/keychain retained conservatively')
  serverReady = false
}
async function identity() { return JSON.parse(await run(process.execPath, [probe, profile], { label: 'Authenticated daemon identity' })).identity }
const ownerKey = owner => JSON.stringify([owner.pid, owner.startedAtMs, owner.launchNonce])
async function observe(item, first = false) {
  await cli(['terminal', 'show', '--terminal', item.handle])
  const nonce = randomBytes(12).toString('hex')
  const text = `${first ? `ORCA_TRANSITION_MEMORY=${item.memory}; ` : ''}printf '%s%s:%s:%s\\n' '${nonce.slice(0, 12)}' '${nonce.slice(12)}' "$$" "$ORCA_TRANSITION_MEMORY"`
  await cli(['terminal', 'send', '--terminal', item.handle, '--text', text, '--enter'])
  const end = Date.now() + 30_000
  while (Date.now() < end) {
    check()
    const read = await cli(['terminal', 'read', '--terminal', item.handle])
    const text = (read?.terminal?.tail ?? []).map(String).join('\n')
    const match = text.match(new RegExp(`${nonce}:([0-9]+):${item.memory}(?:\\r?\\n|$)`))
    if (match) {
      if (item.pid && item.pid !== match[1]) throw new Error('Shell PID changed')
      item.pid = match[1]
      observedShells.add(Number(item.pid))
      return { kind: item.kind, shellPid: item.pid, liveMemoryMatched: true, freshOutputMatched: true }
    }
    await delay(250)
  }
  throw new Error('Live shell nonce/memory verification timed out')
}
const items = []
try {
  const socketBytes = Buffer.byteLength(join(profile, 'daemon', `daemon-v${PROTOCOL_VERSION}.sock`))
  receipt.socketPathBytes = socketBytes
  if (socketBytes >= 104) throw new Error('Disposable daemon socket exceeds macOS sockaddr_un capacity')
  const copies = {}
  for (const [label, input] of [['A', appA], ['B', appB]]) {
    const target = join(root, label, 'Orca.app'); mkdirSync(join(root, label))
    await run('/usr/bin/ditto', [input, target], { timeout: 120_000 })
    await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', target])
    await run('/usr/bin/xcrun', ['stapler', 'validate', target])
    await run('/usr/sbin/spctl', ['--assess', '--type', 'execute', target])
    const signature = await run('/usr/bin/codesign', ['-dv', '--verbose=4', target], { captureStderr: true })
    const team = signature.match(/^TeamIdentifier=(.+)$/m)?.[1]
    if (!team || team === 'not set') throw new Error('Signed app lacks team identity')
    copies[label] = target
    receipt[label] = { input, team, appAsarSha256: await hash(join(target, 'Contents/Resources/app.asar')), cliEntrySha256: await hash(join(target, 'Contents/Resources/app.asar.unpacked/out/cli/index.js')), bunSha256: await hash(join(target, 'Contents/Resources/cli-runtime/bun-runtime')), daemonEntrySha256: await hash(join(target, 'Contents/Resources/terminal-daemon/daemon-entry.js')), version: await run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', join(target, 'Contents/Info.plist')]), executableSha256: await hash(join(target, 'Contents/MacOS/Orca')) }
  }
  if (receipt.A.team !== receipt.B.team) throw new Error('A/B signing teams differ')
  receipt.generationComparison = { sameAppVersion: receipt.A.version === receipt.B.version, sameBun: receipt.A.bunSha256 === receipt.B.bunSha256, sameDaemonEntry: receipt.A.daemonEntrySha256 === receipt.B.daemonEntrySha256 }
  if (compareAppVersions(receipt.B.version, receipt.A.version) <= 0) throw new Error('Signed B version must be newer than A')
  for (const label of ['A', 'B']) {
    const destination = join(root, 'feeds', label); mkdirSync(destination, { recursive: true, mode: 0o700 })
    const content = readFileSync(manifests[label], 'utf8'); const manifest = parseYaml(content)
    if (manifest.version !== receipt[label].version || !Array.isArray(manifest.files) || manifest.files.length > 8) throw new Error('Manifest version/files mismatch')
    const files = manifest.files.filter(file => typeof file.url === 'string' && file.url.endsWith('.zip'))
    if (!files.length) throw new Error('No signed ZIP in manifest')
    for (const file of files) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._ ()+-]*\.zip$/.test(file.url)) throw new Error('Unsafe manifest ZIP path')
      await run('/bin/cp', [join(dirname(manifests[label]), file.url), join(destination, file.url)], { timeout: 120_000, label: 'Stage signed ZIP' })
    }
    writeFileSync(join(destination, 'latest-mac.yml'), content, { mode: 0o600 })
  }
  const installed = join(root, 'installed', 'Orca.app'); mkdirSync(dirname(installed))
  await run('/usr/bin/ditto', [copies.A, installed], { timeout: 120_000 })
  currentVersion = receipt.A.version
  const previousArgv = process.argv
  try {
    process.argv = [...previousArgv.filter(arg => !arg.startsWith('--packaged-app-dir=')), `--packaged-app-dir=${installed}`]
    launch = resolveRuntimeServeSmokeLaunch(source, profile, await availablePort())
  } finally { process.argv = previousArgv }
  // One environment/keychain spans all stages; only the packaged client command changes.
  Object.assign(launch.env, { ORCA_DIAGNOSTIC_UPDATE_ROOT: root, ORCA_DIAGNOSTIC_UPDATE_SECRET: selectionSecret })
  await start(installed)
  const initial = await waitUpdaterReady(currentVersion)
  if (initial.appVersion !== currentVersion || initial.support?.installMode !== 'supervised-headless-serve' || !initial.support.automatic) throw new Error('Initial supervised updater not ready')
  for (const kind of ['git', 'folder']) {
    const path = join(root, kind); mkdirSync(path); writeFileSync(join(path, 'keep.txt'), 'keep\n')
    let repo
    if (kind === 'git') {
      for (const argv of [['init'], ['checkout', '-b', 'main'], ['config', 'user.name', 'Orca Test'], ['config', 'user.email', 'test@orca.test'], ['add', '.'], ['commit', '-m', 'seed']]) await run('git', argv, { cwd: path })
      repo = (await cli(['repo', 'add', '--path', path])).repo
    } else {
      repo = JSON.parse(await run(process.execPath, [folderRpc, profile, path], { label: 'Folder registration', pairing })).repo
      if (repo.kind !== 'folder' || existsSync(join(path, '.git'))) throw new Error('Folder became a Git workspace')
    }
    const worktree = (await cli(['worktree', 'create', '--repo', `id:${repo.id}`, '--name', `transition-${kind}`, '--setup', 'skip'])).worktree
    const handle = (await cli(['terminal', 'create', '--worktree', worktree.id])).terminal.handle
    items.push({ kind, path, worktreeId: worktree.id, handle, memory: randomBytes(12).toString('hex') })
  }
  const owner = await identity()
  for (const [stage, app] of [['A', copies.A], ['B', copies.B], ['A2', copies.A]]) {
    if (stage !== 'A') await transition(stage === 'B' ? 'B' : 'A', installed)
    const current = await identity()
    if (ownerKey(owner) !== ownerKey(current)) throw new Error('Daemon owner changed across client transition')
    const evidence = []
    for (const item of items) evidence.push(await observe(item, stage === 'A'))
    if (stage === 'B') for (const item of items) {
      const handle = (await cli(['terminal', 'create', '--worktree', item.worktreeId])).terminal.handle
      await observe({ kind: item.kind, handle, memory: randomBytes(12).toString('hex') }, true)
      await cli(['terminal', 'close', '--terminal', handle])
    }
    receipt.stages.push({ stage, owner: current, terminals: evidence, freshAdmissions: stage === 'B' })
    if (ownerKey(await identity()) !== ownerKey(owner)) throw new Error('Owner lost after installed transition')
  }
  for (const item of items) {
    await cli(['terminal', 'close', '--terminal', item.handle])
    await cli(['worktree', 'rm', '--worktree', item.worktreeId, '--force'])
    if (item.kind === 'folder' && readFileSync(join(item.path, 'keep.txt'), 'utf8') !== 'keep\n') throw new Error('Folder sentinel lost')
  }
  receipt.status = 'passed'
} catch (error) {
  receipt.status = 'failed'; receipt.error = error.message
} finally {
  cleaning = true
  clearTimeout(totalTimer)
  let serverExited = false, daemonRetired = false
  try { await stop(); serverExited = true; receipt.cleanup.push('serving process exited') } catch (error) { receipt.cleanup.push(error.message); receipt.status = 'failed' }
  try { await run(process.execPath, [cleanup, profile], { cleanup: true, timeout: 15_000, label: 'Authenticated daemon cleanup' }); receipt.cleanup.push('authenticated daemon retired');
    const end = Date.now() + 5_000;
    while ([...observedShells].some(pid => runtimeServeSmokeProcessState(pid) !== 'exited') && Date.now() < end) await delay(50);
    if ([...observedShells].some(pid => runtimeServeSmokeProcessState(pid) !== 'exited')) throw new Error('Shell exit unverifiable after authenticated daemon shutdown');
    daemonRetired = true; receipt.cleanup.push('all observed shells exited') } catch (error) { receipt.cleanup.push(error.message); receipt.status = 'failed' }
  try {
    if (serverExited && daemonRetired && !installInFlight) { launch?.dispose?.(); receipt.cleanup.push('keychain restored') }
    else { receipt.cleanup.push('keychain/profile retained because process exit or native install settlement is unverified'); receipt.status = 'failed' }
  } catch { receipt.cleanup.push('keychain restoration failed'); receipt.status = 'failed' }
  process.off('SIGTERM', cancel); process.off('SIGINT', cancel)
  receipt.cancelled = cancelled
  if (cancelled) receipt.status = 'failed'
  mkdirSync(resolve(receiptPath, '..'), { recursive: true }); writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n')
  if (receipt.status === 'passed') rmSync(root, { recursive: true, force: true })
}
process.exitCode = receipt.status === 'passed' ? 0 : 1
