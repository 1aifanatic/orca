// Electron/updater are mocked: only private temporary files and timers are exercised.
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync, readFileSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
const previous = { ...process.env }
const root = realpathSync(mkdtempSync(join(tmpdir(), 'ous-')))
const secret = 'a'.repeat(64)
const manifest = join(root, 'feeds', 'B', 'latest-mac.yml')
mkdirSync(join(root, 'feeds', 'B'), { recursive: true })
writeFileSync(manifest, 'version: 2.0.0\n', { mode: 0o600 })
Object.assign(process.env, { CI: 'true', ORCA_BACKGROUND_LAUNCH: '1', ORCA_ISOLATED_CI_USER: '1', ORCA_DIAGNOSTIC_UPDATE_ROOT: root, ORCA_DIAGNOSTIC_UPDATE_SECRET: secret })
globalThis.__overlayState = 'idle'; globalThis.__overlayChecks = 0; globalThis.__overlayVersion = '1.0.0'; globalThis.__overlayCleanup = []
const bundle = await build({ entryPoints: [join(import.meta.dirname, 'diagnostic-update-selection.ts')], bundle: true, write: false, format: 'esm', platform: 'node', plugins: [{ name: 'mock-electron-updater', setup(builder) {
  builder.onResolve({ filter: /^(electron|\.\.\/updater)$/ }, args => ({ path: args.path, namespace: 'test' }))
  builder.onLoad({ filter: /.*/, namespace: 'test' }, args => ({ contents: args.path === 'electron' ? `export const app={isPackaged:true,isReady:()=>true,getVersion:()=>globalThis.__overlayVersion,once:(_,fn)=>globalThis.__overlayCleanup.push(fn)}` : `export const getUpdateStatus=()=>({state:globalThis.__overlayState});export const getRemoteServerUpdateSupport=()=>({automatic:true});export const checkForUpdatesFromMenu=()=>{globalThis.__overlayChecks++}` }))
} }] })
const text = bundle.outputFiles[0].text
const module = await import(`data:text/javascript;base64,${Buffer.from(text).toString('base64')}`)
const request = value => writeFileSync(join(root, 'update-request.json'), JSON.stringify(value), { mode: 0o600 })
try {
  globalThis.__overlayState = 'checking'
  module.startDiagnosticUpdateSelection()
  request({ id: '1'.repeat(32), secret, manifest, fromVersion: '1.0.0', targetVersion: '2.0.0' })
  await delay(300)
  assert.equal(globalThis.__overlayChecks, 0, 'checking must defer without consuming request')
  globalThis.__overlayState = 'downloading'
  await delay(300)
  assert.equal(globalThis.__overlayChecks, 0, 'downloading must also defer')
  globalThis.__overlayState = 'idle'
  await delay(300)
  assert.equal(globalThis.__overlayChecks, 1, 'same pending file selected exactly once after idle')
  assert.equal(module.diagnosticManifestSelection(), manifest)
  assert.throws(() => module.diagnosticManifestSelection(), /not_requested/)
  assert.throws(() => module.confirmDiagnosticSelection('1.0.0'), /version_mismatch/)
  assert.equal(module.confirmDiagnosticSelection('2.0.0'), true)
  const response = JSON.parse(readFileSync(join(root, 'update-response.json'), 'utf8'))
  assert.equal(response.phase, 'selected'); assert.ok(!JSON.stringify(response).includes(secret))
  await delay(300); assert.equal(globalThis.__overlayChecks, 1, 'same request must not replay')
  request({ id: '2'.repeat(32), secret: 'b'.repeat(64), manifest, fromVersion: '1.0.0', targetVersion: '2.0.0' })
  await delay(300)
  assert.equal(JSON.parse(readFileSync(join(root, 'update-response.json'), 'utf8')).phase, 'refused')
  assert.equal(globalThis.__overlayChecks, 1, 'unauthorized request must not call updater')
  for (const close of globalThis.__overlayCleanup.splice(0)) close()
  async function fresh(suffix, version) {
    globalThis.__overlayVersion = version; globalThis.__overlayChecks = 0
    return import(`data:text/javascript;base64,${Buffer.from(text + '\n// ' + suffix).toString('base64')}`)
  }
  const rollback = await fresh('rollback', '2.0.0')
  request({ id: '3'.repeat(32), secret, manifest, fromVersion: '1.0.0', targetVersion: '2.0.0' })
  rollback.startDiagnosticUpdateSelection(); await delay(300)
  assert.equal(globalThis.__overlayChecks, 0, 'installed-target stale request must not poison replacement process')
  request({ id: '4'.repeat(32), secret, manifest, fromVersion: '2.0.0', targetVersion: '1.0.0' })
  await delay(300); assert.equal(globalThis.__overlayChecks, 1)
  assert.equal(rollback.diagnosticManifestSelection(), manifest)
  assert.equal(rollback.confirmDiagnosticSelection('1.0.0'), true, 'explicit downgrade remains allowed')
  for (const close of globalThis.__overlayCleanup.splice(0)) close()
  for (const [name, change] of [
    ['same-version', value => { value.targetVersion = value.fromVersion }],
    ['outside-root', value => { value.manifest = '/tmp/latest-mac.yml' }],
    ['public-request', () => {}]
  ]) {
    const instance = await fresh(name, '1.0.0')
    const value = { id: '5'.repeat(32), secret, manifest, fromVersion: '1.0.0', targetVersion: '2.0.0' }
    change(value); request(value)
    if (name === 'public-request') chmodSync(join(root, 'update-request.json'), 0o644)
    instance.startDiagnosticUpdateSelection(); await delay(300)
    assert.equal(globalThis.__overlayChecks, 0, name)
    assert.equal(JSON.parse(readFileSync(join(root, 'update-response.json'), 'utf8')).phase, 'refused', name)
    chmodSync(join(root, 'update-request.json'), 0o600)
    for (const close of globalThis.__overlayCleanup.splice(0)) close()
  }
  console.log('Selection overlay: secret/path/mode/version fences, one-shot requests, stale-request survival and explicit downgrade passed')
} finally {
  for (const close of globalThis.__overlayCleanup) close()
  for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key]
  Object.assign(process.env, previous)
  rmSync(root, { recursive: true, force: true })
}
