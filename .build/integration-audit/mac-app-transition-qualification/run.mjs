/** Local diagnostic: signed client-artifact continuity, never updater qualification. */
import { spawn } from 'node:child_process'
import { randomBytes, createHash } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { resolveRuntimeServeSmokeLaunch, readRuntimeServeSmokePid, runtimeServeSmokeProcessState } from '../../../config/scripts/runtime-serve-smoke-launch.mjs'
import { stopServer } from '../../../config/scripts/runtime-serve-smoke-shutdown.mjs'

const args = new Map(process.argv.slice(2).map(arg => { const i = arg.indexOf('='); return [arg.slice(0, i), arg.slice(i + 1)] }))
const required = key => { const value = args.get(key); if (!value) throw new Error(`Required: ${key}=...`); return resolve(value) }
if (process.platform !== 'darwin' || process.env.CI !== 'true' || process.env.ORCA_ISOLATED_CI_USER !== '1') {
  throw new Error('Requires an isolated macOS CI user; this changes the user default keychain')
}
const source = resolve(import.meta.dirname, '../../..')
const appA = required('--app-a'), appB = required('--app-b'), receiptPath = required('--receipt')
const probe = required('--probe'), cleanup = required('--cleanup'), folderRpc = required('--folder-rpc')
const root = mkdtempSync(join(tmpdir(), 'orca-client-transition-'))
const profile = join(root, 'profile')
const receipt = { scope: 'signed client-artifact A-B-A; not updater/version/runtime-generation qualification', status: 'running', root, stages: [], cleanup: [] }
let child, launch, pairing, command, servingPid, serverReady = false, cancelled = false, cleaning = false
const auxiliaries = new Set()
const observedShells = new Set()
const cancel = () => { cancelled = true; if (!cleaning) for (const child of auxiliaries) child.kill('SIGKILL') }
process.on('SIGTERM', cancel)
process.on('SIGINT', cancel)
const totalTimer = setTimeout(cancel, 12 * 60_000)
function check() { if (cancelled) throw new Error('Qualification cancelled or total deadline reached') }
function run(program, argv, options = {}) {
  if (!options.cleanup) check()
  return new Promise((resolvePromise, reject) => {
    const proc = spawn(program, argv, { cwd: options.cwd ?? source, env: { ...process.env, ...launch?.env, ORCA_PAIRING_CODE: options.pairing, ORCA_BACKGROUND_LAUNCH: '1' }, stdio: ['ignore', 'pipe', 'pipe'] })
    auxiliaries.add(proc)
    let output = '', size = 0, failure
    const timer = setTimeout(() => { failure = 'command timeout'; proc.kill('SIGKILL') }, options.timeout ?? 30_000)
    proc.stdout.on('data', data => { size += data.length; if (size > 2 ** 20) { failure = 'command output cap'; proc.kill('SIGKILL') } else output += data })
    proc.stderr.on('data', data => { size += data.length; if (options.captureStderr && size <= 2 ** 20) output += data; if (size > 2 ** 20) { failure = 'command output cap'; proc.kill('SIGKILL') } })
    proc.once('error', () => { failure = 'command spawn failed' })
    proc.once('close', code => {
      clearTimeout(timer); auxiliaries.delete(proc)
      if (failure || code !== 0) reject(new Error(`${options.label ?? 'diagnostic command'}: ${failure ?? `exit ${code}`}`))
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
  const ready = await new Promise((resolvePromise, reject) => {
    let pending = '', bytes = 0, settled = false
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); clearInterval(poll); error ? reject(error) : resolvePromise(value) }
    const timer = setTimeout(() => finish(new Error('Server readiness timeout')), 120_000)
    const poll = setInterval(() => { if (cancelled) finish(new Error('Cancelled during startup')) }, 100)
    child.once('error', () => finish(new Error('Server spawn failed')))
    child.once('exit', code => finish(new Error(`Server exited before ready: ${code}`)))
    child.stderr.on('data', () => {})
    child.stdout.on('data', data => {
      if (settled) return
      bytes += data.length
      if (bytes > 2 ** 20) return finish(new Error('Server readiness output cap'))
      pending += data
      const lines = pending.split('\n'); pending = lines.pop()
      for (const line of lines) {
        try { const data = JSON.parse(line); if (data.type === 'orca_server_ready') finish(null, data) } catch {}
      }
    })
  })
  pairing = new URL(ready.pairing.url).searchParams.get('code')
  if (!pairing) throw new Error('No pairing code')
  servingPid = readRuntimeServeSmokePid(profile)
  if (!servingPid) throw new Error('No serving process identity')
  serverReady = true
}
async function stop() {
  if (!child) return
  // PID comes only from this fresh profile; stopServer checks launcher and serving process exit.
  await stopServer(child, undefined, false, servingPid ?? readRuntimeServeSmokePid(profile))
  child = undefined; servingPid = undefined; pairing = undefined
  if (!serverReady) throw new Error('Startup never established serving identity; profile/keychain retained conservatively')
  serverReady = false
}
async function identity() { return JSON.parse(await run(process.execPath, [probe, profile])).identity }
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
    receipt[label] = { input, team, bunSha256: await hash(join(target, 'Contents/Resources/cli-runtime/bun-runtime')), daemonEntrySha256: await hash(join(target, 'Contents/Resources/terminal-daemon/daemon-entry.js')), version: await run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', join(target, 'Contents/Info.plist')]), executableSha256: await hash(join(target, 'Contents/MacOS/Orca')) }
  }
  if (receipt.A.team !== receipt.B.team) throw new Error('A/B signing teams differ')
  receipt.generationComparison = { sameAppVersion: receipt.A.version === receipt.B.version, sameBun: receipt.A.bunSha256 === receipt.B.bunSha256, sameDaemonEntry: receipt.A.daemonEntrySha256 === receipt.B.daemonEntrySha256 }
  const previousArgv = process.argv
  try {
    process.argv = [...previousArgv.filter(arg => !arg.startsWith('--packaged-app-dir=')), `--packaged-app-dir=${copies.A}`]
    launch = resolveRuntimeServeSmokeLaunch(source, profile, await availablePort())
  } finally { process.argv = previousArgv }
  // One environment/keychain spans all stages; only the packaged client command changes.
  await start(copies.A)
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
    if (stage !== 'A') await start(app)
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
    if (stage !== 'A2') { await stop(); if (ownerKey(await identity()) !== ownerKey(owner)) throw new Error('Owner lost between stages') }
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
  try { await run(process.execPath, [cleanup, profile], { cleanup: true, timeout: 15_000 }); receipt.cleanup.push('authenticated daemon retired');
    const end = Date.now() + 5_000;
    while ([...observedShells].some(pid => runtimeServeSmokeProcessState(pid) !== 'exited') && Date.now() < end) await delay(50);
    if ([...observedShells].some(pid => runtimeServeSmokeProcessState(pid) !== 'exited')) throw new Error('Shell exit unverifiable after authenticated daemon shutdown');
    daemonRetired = true; receipt.cleanup.push('all observed shells exited') } catch (error) { receipt.cleanup.push(error.message); receipt.status = 'failed' }
  try {
    if (serverExited && daemonRetired) { launch?.dispose?.(); receipt.cleanup.push('keychain restored') }
    else { receipt.cleanup.push('keychain/profile retained because serving-process or daemon/session exit is unverified'); receipt.status = 'failed' }
  } catch { receipt.cleanup.push('keychain restoration failed'); receipt.status = 'failed' }
  process.off('SIGTERM', cancel); process.off('SIGINT', cancel)
  receipt.cancelled = cancelled
  if (cancelled) receipt.status = 'failed'
  mkdirSync(resolve(receiptPath, '..'), { recursive: true }); writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n')
  if (receipt.status === 'passed') rmSync(root, { recursive: true, force: true })
}
process.exitCode = receipt.status === 'passed' ? 0 : 1
