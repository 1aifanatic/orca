import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Script } from 'node:vm'

export const WINDOWS_TERMINAL_SHA256 =
  '8247ecd69be8b18257050fb026b290024612c5ffc6d492ff1d46f81e613be2cf'
const MODULE_PATH = 'node_modules/node-pty/lib/windowsTerminal.js'

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function replaceOnce(source, from, to) {
  if (source.split(from).length !== 2) {
    throw new Error('Native input diagnostic anchor drifted')
  }
  return source.replace(from, to)
}

export function instrumentWindowsTerminal(source) {
  if (sha256(source) !== WINDOWS_TERMINAL_SHA256) {
    throw new Error('Refusing unexpected staged WindowsTerminal bytes')
  }
  const logger = `
function orcaInputTrace(terminal, phase, extra) {
    var trace = terminal._orcaInputTrace;
    if (!trace || trace.records >= 128) return;
    trace.records++;
    try {
        process.stderr.write('ORCA_SSH_NATIVE_INPUT ' + JSON.stringify(Object.assign({
            phase: phase, sequence: trace.records, at: Date.now(), pid: terminal._agent.innerPid,
            pty: terminal._agent.pty, ready: terminal._isReady,
            pending: terminal._deferreds.length, writable: terminal._writable
        }, extra)) + '\\n');
    } catch (_) {}
}
`
  source = replaceOnce(
    source,
    "var DEFAULT_FILE = 'cmd.exe';",
    `${logger}var DEFAULT_FILE = 'cmd.exe';`
  )
  const setup = `        _this._orcaInputTrace = opt.env.ORCA_SSH_INPUT_DIAGNOSTICS === '1' ? { records: 0 } : null;
        orcaInputTrace(_this, 'constructed', { useConptyDll: opt.useConptyDll === true });
        if (_this._orcaInputTrace) {
            _this._socket.on('ready_datapipe', function () { orcaInputTrace(_this, 'ready-datapipe'); });
            _this._socket.once('data', function (data) { orcaInputTrace(_this, 'first-output', { bytes: Buffer.byteLength(data) }); });
            _this._agent.inSocket.on('error', function (error) { orcaInputTrace(_this, 'input-error', { code: typeof error.code === 'string' ? error.code : null }); });
        }
`
  source = replaceOnce(
    source,
    '        // Not available until `ready` event emitted.',
    `${setup}        // Not available until \`ready\` event emitted.`
  )
  source = replaceOnce(
    source,
    '        this._defer(this._doWrite, data);',
    "        orcaInputTrace(this, 'write-requested', { bytes: Buffer.byteLength(data) });\n        this._defer(this._doWrite, data);"
  )
  source = replaceOnce(
    source,
    '        this._agent.inSocket.write(data);',
    `        if (!this._orcaInputTrace) {
            this._agent.inSocket.write(data);
            return;
        }
        var terminal = this;
        orcaInputTrace(this, 'pipe-write-start', { bytes: Buffer.byteLength(data) });
        try {
            var accepted = this._agent.inSocket.write(data, function (error) {
                orcaInputTrace(terminal, 'pipe-write-settled', { outcome: error ? 'error' : 'accepted', code: error && typeof error.code === 'string' ? error.code : null });
            });
            orcaInputTrace(this, 'pipe-write-returned', { accepted: accepted });
        } catch (error) {
            orcaInputTrace(this, 'pipe-write-threw', { code: typeof error.code === 'string' ? error.code : null });
            throw error;
        }`
  )
  new Script(source)
  return source
}

export function stageNativeInputDiagnostics(root, env = process.env) {
  if (
    env.GITHUB_ACTIONS !== 'true' ||
    env.ORCA_ISOLATED_SSH_CI !== '1' ||
    env.ORCA_BACKGROUND_LAUNCH !== '1' ||
    env.ORCA_SSH_INPUT_DIAGNOSTICS !== '1'
  ) {
    throw new Error('Native input instrumentation requires explicit isolated background CI')
  }
  const template = join(root, 'out', 'orcad-template')
  const manifestPath = join(template, 'orcad-template.json')
  const modulePath = join(template, ...MODULE_PATH.split('/'))
  const before = readFileSync(modulePath)
  const originalManifest = readFileSync(manifestPath)
  const manifest = JSON.parse(originalManifest)
  if (
    manifest.schemaVersion !== 3 ||
    manifest.commonSha256[MODULE_PATH] !== sha256(before) ||
    Object.keys(manifest.targets).length !== 1 ||
    !Object.hasOwn(manifest.targets, 'win32-x64')
  ) {
    throw new Error('Staged native input module does not match its template manifest')
  }
  const after = Buffer.from(instrumentWindowsTerminal(before.toString('utf8')))
  const receiptRoot = join(root, '.build', 'ssh-windows-host-receipts')
  mkdirSync(receiptRoot, { recursive: true })
  writeFileSync(join(receiptRoot, 'native-input-original-windowsTerminal.js'), before)
  writeFileSync(join(receiptRoot, 'native-input-original-template-manifest.json'), originalManifest)
  manifest.commonSha256[MODULE_PATH] = sha256(after)
  const stagedManifest = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)
  const temporaryPath = `${modulePath}.orca-diagnostic`
  writeFileSync(temporaryPath, after)
  renameSync(temporaryPath, modulePath)
  writeFileSync(manifestPath, stagedManifest)
  writeFileSync(join(receiptRoot, 'native-input-staged-windowsTerminal.js'), after)
  writeFileSync(join(receiptRoot, 'native-input-staged-template-manifest.json'), stagedManifest)
  const receipt = {
    module: MODULE_PATH,
    originalSha256: sha256(before),
    stagedSha256: sha256(after),
    originalManifestSha256: sha256(originalManifest),
    stagedManifestSha256: sha256(stagedManifest),
    moduleReadbackExact: readFileSync(modulePath).equals(after),
    manifestReadbackExact: readFileSync(manifestPath).equals(stagedManifest),
    maxRecordsPerPrivatePty: 128,
    nativePayloadLogged: false,
    optionalPipeCallbackIsAcceptanceOnly: true
  }
  if (!receipt.moduleReadbackExact || !receipt.manifestReadbackExact) {
    throw new Error('Native diagnostic staging readback failed')
  }
  writeFileSync(
    join(receiptRoot, 'native-input-staging-receipt.json'),
    `${JSON.stringify(receipt, null, 2)}\n`
  )
  return receipt
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  stageNativeInputDiagnostics(process.cwd())
}
