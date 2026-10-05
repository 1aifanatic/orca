const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const { syncBuiltinESMExports } = require('node:module')
const crypto = require('node:crypto')
const stdoutHash = crypto.createHash('sha256')
const stderrHash = crypto.createHash('sha256')
for (const [stream, hash] of [[process.stdout, stdoutHash], [process.stderr, stderrHash]]) {
  const prior = stream.write
  stream.write = function (chunk, encoding, _callback) {
    hash.update(typeof chunk === 'string' ? Buffer.from(chunk, typeof encoding === 'string' ? encoding : 'utf8') : chunk)
    return prior.apply(this, arguments)
  }
}
const mutations = []
const nativeAttempts = []
const write = fs.writeFileSync
const rename = fs.renameSync
const target = process.env.ORCA_TYPECHECK_GUARD_RECEIPTS
const toolPath = (process.argv[1] ?? '').replaceAll('\\', '/')
const preToolHeld = process.env.ORCA_TYPECHECK_CANCEL_HOLD === 'true' && /\/typescript\/(?:bin\/tsc|lib\/tsc\.js)$/.test(toolPath)
const save = (phase, code) => {
  if (!target) return
  const destination = path.join(target, `${process.pid}.json`)
  const temporary = destination + '.tmp'
  write(temporary, JSON.stringify({ phase, pid: process.pid, ppid: process.ppid, argv: process.argv, code, preToolHeld, nativeAttempts, mutations, stdoutSha256: stdoutHash.copy().digest('hex'), stderrSha256: stderrHash.copy().digest('hex') }))
  rename(temporary, destination)
}
const record = (name, args) => mutations.push({ name, path: typeof args[0] === 'string' ? args[0] : null })
for (const name of ['writeFileSync', 'appendFileSync', 'mkdirSync', 'renameSync', 'unlinkSync', 'rmSync', 'rmdirSync', 'copyFileSync', 'truncateSync', 'writeSync', 'chmodSync', 'chownSync', 'symlinkSync', 'linkSync', 'utimesSync']) {
  const prior = fs[name]
  if (prior) fs[name] = function (...args) { record(name, args); return prior.apply(this, args) }
}
for (const name of ['writeFile', 'appendFile', 'mkdir', 'rename', 'unlink', 'rm', 'rmdir', 'copyFile', 'truncate', 'chmod', 'chown', 'symlink', 'link', 'utimes']) {
  const prior = fs[name]
  if (prior) fs[name] = function (...args) { record(name, args); return prior.apply(this, args) }
  const promise = fs.promises[name]
  if (promise) fs.promises[name] = function (...args) { record('promises.' + name, args); return promise.apply(this, args) }
}
for (const name of ['open', 'openSync']) {
  const prior = fs[name]
  fs[name] = function (...args) {
    if (typeof args[1] === 'string' && /[wa+]/.test(args[1])) record(name, args)
    return prior.apply(this, args)
  }
}
Module._extensions['.node'] = function (_module, filename) {
  nativeAttempts.push(filename)
  save('native-denied')
  throw new Error('TYPECHECK_NATIVE_DENIED: ' + filename)
}
process.dlopen = function (_module, filename) {
  nativeAttempts.push(filename)
  save('native-denied')
  throw new Error('TYPECHECK_NATIVE_DENIED: ' + filename)
}
syncBuiltinESMExports()
save('boot')
process.once('exit', code => save('exit', code))
if (preToolHeld) {
  const release = process.env.ORCA_TYPECHECK_CANCEL_RELEASE_FILE
  if (!release) throw new Error('Cancellation hold requires an owned release file')
  const sleeper = new Int32Array(new SharedArrayBuffer(4))
  const deadline = Date.now() + 5 * 60_000
  while (!fs.existsSync(release)) {
    if (Date.now() > deadline) throw new Error('Bounded pre-tool cancellation hold expired')
    Atomics.wait(sleeper, 0, 0, 100)
  }
}
