#!/usr/bin/env python3
"""Derive the installed-update diagnostic from the reviewed client-transition driver."""
import pathlib
here=pathlib.Path(__file__).resolve().parent
source=here.parent/'mac-app-transition-qualification/run.mjs'
s=source.read_text()
s=s.replace("/** Local diagnostic: signed client-artifact continuity, never updater qualification. */", "/** Diagnostic signed-build updater: one stable installation, native replacement and rollback. */")
s=s.replace("writeFileSync } from 'node:fs'", "writeFileSync, realpathSync, copyFileSync, renameSync } from 'node:fs'")
s=s.replace("from './command-failure.mjs'", "from '../mac-app-transition-qualification/command-failure.mjs'")
s="import { compareAppVersions } from '../../../src/shared/app-version.ts'\nimport { parse as parseYaml } from 'yaml'\nimport { dirname } from 'node:path'\nimport { createReadinessQueue } from './readiness-queue.mjs'\n"+s
s=s.replace("const root = mkdtempSync(join(tmpdir(), 'oct-'))", "const root = realpathSync(mkdtempSync(join(tmpdir(), 'oui-')))\nconst manifests = { A: required('--manifest-a'), B: required('--manifest-b') }\nconst updaterControl = required('--updater-control')\nconst selectionSecret = randomBytes(32).toString('hex')\nlet readiness, currentVersion, installInFlight = false")
s=s.replace("signed client-artifact A-B-A; not updater/version/runtime-generation qualification", "native signed diagnostic-build installed update and downgrade; no renderer or Bun-generation claim")
s=s.replace('12 * 60_000','25 * 60_000')
s=s.replace("receipt[label] = { input, team,", "receipt[label] = { input, team, appAsarSha256: await hash(join(target, 'Contents/Resources/app.asar')), cliEntrySha256: await hash(join(target, 'Contents/Resources/app.asar.unpacked/out/cli/index.js')),")
start=s.index('async function start(app) {');end=s.index('async function stop() {',start)
s=s[:start]+'''async function start(app) {
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
''' + s[end:]
s=s.replace("  const previousArgv = process.argv", "  if (compareAppVersions(receipt.B.version, receipt.A.version) <= 0) throw new Error('Signed B version must be newer than A')\n  for (const label of ['A', 'B']) {\n    const destination = join(root, 'feeds', label); mkdirSync(destination, { recursive: true, mode: 0o700 })\n    const content = readFileSync(manifests[label], 'utf8'); const manifest = parseYaml(content)\n    if (manifest.version !== receipt[label].version || !Array.isArray(manifest.files) || manifest.files.length > 8) throw new Error('Manifest version/files mismatch')\n    const files = manifest.files.filter(file => typeof file.url === 'string' && file.url.endsWith('.zip'))\n    if (!files.length) throw new Error('No signed ZIP in manifest')\n    for (const file of files) {\n      if (!/^[A-Za-z0-9][A-Za-z0-9._ ()+-]*\\.zip$/.test(file.url)) throw new Error('Unsafe manifest ZIP path')\n      await run('/bin/cp', [join(dirname(manifests[label]), file.url), join(destination, file.url)], { timeout: 120_000, label: 'Stage signed ZIP' })\n    }\n    writeFileSync(join(destination, 'latest-mac.yml'), content, { mode: 0o600 })\n  }\n  const installed = join(root, 'installed', 'Orca.app'); mkdirSync(dirname(installed))\n  await run('/usr/bin/ditto', [copies.A, installed], { timeout: 120_000 })\n  currentVersion = receipt.A.version\n  const previousArgv = process.argv")
s=s.replace('`--packaged-app-dir=${copies.A}`','`--packaged-app-dir=${installed}`')
s=s.replace("  await start(copies.A)", "  Object.assign(launch.env, { ORCA_DIAGNOSTIC_UPDATE_ROOT: root, ORCA_DIAGNOSTIC_UPDATE_SECRET: selectionSecret })\n  await start(installed)\n  const initial = await waitUpdaterReady(currentVersion)\n  if (initial.appVersion !== currentVersion || initial.support?.installMode !== 'supervised-headless-serve' || !initial.support.automatic) throw new Error('Initial supervised updater not ready')")
s=s.replace("    if (stage !== 'A') await start(app)", "    if (stage !== 'A') await transition(stage === 'B' ? 'B' : 'A', installed)")
s=s.replace("    if (stage !== 'A2') { await stop(); if (ownerKey(await identity()) !== ownerKey(owner)) throw new Error('Owner lost between stages') }", "    if (ownerKey(await identity()) !== ownerKey(owner)) throw new Error('Owner lost after installed transition')")
s=s.replace("if (serverExited && daemonRetired)", "if (serverExited && daemonRetired && !installInFlight)")
s=s.replace("because serving-process or daemon/session exit is unverified", "because process exit or native install settlement is unverified")
(here/'run-installed.mjs').write_text(s)
print('Derived local installed updater driver; no application launched')
