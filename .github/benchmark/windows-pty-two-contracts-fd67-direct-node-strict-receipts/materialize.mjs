import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync, mkdirSync, realpathSync, renameSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const definition = dirname(fileURLToPath(import.meta.url))
const m = JSON.parse(readFileSync(join(definition, 'manifest.json')))
const root = resolve(m.resultRoot)
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const hashFile = file => sha(readFileSync(file))
const writeJson = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' })
const git = args => execFileSync('git', args, { timeout: 20000, env: { ...process.env, GIT_NO_LAZY_FETCH: '1', GIT_OPTIONAL_LOCKS: '0' }, encoding: 'utf8' }).trim()
const require = createRequire(resolve('package.json'))
const ptyRoot = dirname(require.resolve('node-pty/package.json'))
const owner = file => realpathSync(join(ptyRoot, file))
const expected = phase => {
  const map = { ...m.sourceGuards }
  if (phase !== 'original') for (const file of m.commonTargets) map[file] = m.payload[file].sha256
  if (phase === 'after') for (const file of m.afterTargets) map[file] = m.payload[file].sha256
  return map
}
function sourceSnapshot(phase) {
  const actual = {}
  for (const [file, digest] of Object.entries(expected(phase))) {
    actual[file] = existsSync(file) ? hashFile(file) : null
    assert.equal(actual[file], digest, `Source ${phase}: ${file}`)
  }
  return actual
}
function installedSnapshot() {
  assert.equal(process.platform, 'win32'); assert.match(process.version, /^v24\.\d+\.\d+$/); assert.equal(process.arch, 'x64'); assert.equal(process.versions.bun, undefined)
  assert.equal(require('vitest/package.json').version, '5.0.3'); assert.equal(require('node-pty/package.json').version, '1.1.0')
  const utilsPath = require.resolve('node-pty/lib/utils')
  const loaded = require(utilsPath).loadNativeModule('conpty')
  const addon = resolve(dirname(utilsPath), loaded.dir, 'conpty.node')
  const paths = {
    'conpty.node': addon, 'conpty.dll': join(dirname(addon), 'conpty', 'conpty.dll'),
    'OpenConsole.exe': join(dirname(addon), 'conpty', 'OpenConsole.exe'),
    ...Object.fromEntries(['utils.js', 'windowsTerminal.js', 'windowsPtyAgent.js', 'windowsConoutConnection.js', 'worker/conoutSocketWorker.js'].map(file => [file, require.resolve(`node-pty/lib/${file}`)])),
    'windowsTerminal.ts': owner('src/windowsTerminal.ts')
  }
  return { node: process.version, executable: realpathSync(process.execPath), executableSha256: hashFile(process.execPath), vitest: '5.0.3', files: Object.fromEntries(Object.entries(paths).map(([name, file]) => [name, { path: realpathSync(file), bytes: readFileSync(file).length, sha256: hashFile(file) }])) }
}
function equalUnchanged(before, after) {
  assert.equal(before.executable, after.executable); assert.equal(before.executableSha256, after.executableSha256)
  for (const name of Object.keys(before.files)) if (!['windowsTerminal.js', 'windowsTerminal.ts'].includes(name)) assert.deepEqual(after.files[name], before.files[name], `Unchanged input ${name}`)
}
function copyPayload(target) {
  const item = m.payload[target]; const bytes = readFileSync(join(definition, 'payload', item.file)); assert.equal(sha(bytes), item.sha256)
  mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, bytes)
}
function snapshot(phase) {
  return { phase, sourceSha: m.sourceSha, definitionSha: process.env.GITHUB_SHA, runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT, manifestSha256: hashFile(join(definition, 'manifest.json')), source: sourceSnapshot(phase), installed: installedSnapshot() }
}
const [mode, phase, code, startedAt, elapsedMs] = process.argv.slice(2)
assert.equal(process.env.PTY_DIAGNOSTIC_SOURCE_SHA, m.sourceSha)
if (mode === 'prepare') {
  assert.equal(m.status, 'SOURCE-READY-runtime-pending'); assert.equal(git(['rev-parse', 'HEAD']), m.sourceSha)
  assert.equal(git(['status', '--porcelain', '--untracked-files=no']), '')
  sourceSnapshot('original'); assert(!existsSync(root)); mkdirSync(root, { recursive: true })
  mkdirSync(join(root, 'original-source')); mkdirSync(join(root, 'native-before'))
  for (const file of Object.keys(m.sourceGuards)) if (existsSync(file)) { const dest = join(root, 'original-source', file); mkdirSync(dirname(dest), { recursive: true }); writeFileSync(dest, readFileSync(file), { flag: 'wx' }) }
  for (const file of m.commonTargets) copyPayload(file)
  const reporter = readFileSync(join(definition, 'payload', 'report-details-reporter.mjs')); assert.equal(sha(reporter), m.reporterSha256); writeFileSync(join(root, 'report-details-reporter.mjs'), reporter, { flag: 'wx' })
  const before = snapshot('before')
  assert.equal(before.installed.files['windowsTerminal.js'].sha256, m.installedBefore['lib/windowsTerminal.js'])
  assert.equal(before.installed.files['windowsTerminal.ts'].sha256, m.installedBefore['src/windowsTerminal.ts'])
  for (const name of ['conpty.node', 'conpty.dll', 'OpenConsole.exe']) writeFileSync(join(root, 'native-before', name), readFileSync(before.installed.files[name].path), { flag: 'wx' })
  for (const file of ['lib/windowsTerminal.js', 'src/windowsTerminal.ts']) writeFileSync(join(root, 'native-before', file.split('/').at(-1)), readFileSync(owner(file)), { flag: 'wx' })
  writeJson(join(root, 'manifest.json'), m); writeJson(join(root, 'before-context.json'), before)
} else if (mode === 'switch') {
  const admission = JSON.parse(readFileSync(join(root, 'before-admission.json'))); assert.equal(admission.qualified, true)
  const before = JSON.parse(readFileSync(join(root, 'before-context.json')))
  assert.equal(admission.beforeReceiptSha256, hashFile(join(root, 'before-command.json')))
  assert.deepEqual(installedSnapshot(), before.installed); sourceSnapshot('before')
  for (const file of ['lib/windowsTerminal.js', 'src/windowsTerminal.ts']) {
    const path = owner(file); assert.equal(hashFile(path), m.installedBefore[file]); const item = m.payload[file]
    const bytes = readFileSync(join(definition, 'payload', item.file)); assert.equal(sha(bytes), item.sha256)
    const temporary = `${path}.orca-pty-${process.env.GITHUB_RUN_ID}-${process.pid}`
    assert(!existsSync(temporary)); writeFileSync(temporary, bytes, { flag: 'wx' }); renameSync(temporary, path); assert.equal(hashFile(path), item.sha256)
    writeFileSync(join(root, 'native-before', 'after-' + file.split('/').at(-1)), bytes, { flag: 'wx' })
  }
  for (const file of m.afterTargets) copyPayload(file)
  const after = snapshot('after'); equalUnchanged(before.installed, after.installed); writeJson(join(root, 'after-context.json'), after)
} else if (mode === 'record') {
  assert(['before', 'after'].includes(phase)); const context = JSON.parse(readFileSync(join(root, `${phase}-context.json`)))
  const end = snapshot(phase); assert.deepEqual(end.source, context.source); assert.deepEqual(end.installed, context.installed)
  const duration = Number(elapsedMs); assert(Number.isFinite(duration) && duration > 0)
  writeJson(join(root, `${phase}-command.json`), { ...end, code: Number(code), startedAt, endedAt: new Date().toISOString(), elapsedMs: duration, naturalForegroundReturn: true, argv: m.argv[phase] })
} else throw new Error(`Unknown mode ${mode}`)
