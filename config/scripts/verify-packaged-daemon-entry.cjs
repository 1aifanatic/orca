const { existsSync, mkdtempSync, readFileSync, rmSync, statSync } = require('node:fs')
const { spawn, spawnSync } = require('node:child_process')
const { randomUUID } = require('node:crypto')
const { connect } = require('node:net')
const { join } = require('node:path')
const { setTimeout: delay } = require('node:timers/promises')
const { macTerminalHostPaths } = require('./macos-terminal-host-bundle.cjs')
const {
  daemonProtocolVersion
} = require('../../src/shared/local-build-compatibility-contract.json')

// Why: `asarUnpack` in config/electron-builder.config.cjs lists
// out/main/daemon-entry.js on every platform, and the packaged daemon fork
// (src/main/daemon/daemon-init.ts) resolves exactly this unpacked path. A
// missing entry means the package layout regressed, so the check throws
// instead of skipping — a silent skip false-passed exactly the layout bug
// this gate exists to catch.
function assertPackagedDaemonEntryExists(resourcesDir) {
  const entryPath = join(resourcesDir, 'app.asar.unpacked', 'out', 'main', 'daemon-entry.js')
  if (!existsSync(entryPath)) {
    throw new Error(
      `[verify-packaged-daemon-entry] missing unpacked daemon entry at ${entryPath} — ` +
        `asarUnpack expects out/main/daemon-entry.js on every platform, so the packaged ` +
        `daemon cannot be forked from this layout`
    )
  }
  return entryPath
}

// Why: v1.4.129-rc.1 shipped a terminal daemon that could not load (an electron
// `require` leaked into its bundle) while every build check passed. This boots
// the PACKAGED daemon-entry under plain Node against the asar-unpacked layout,
// so a bundling / asar-unpack regression fails packaging instead of reaching
// users. Module-load proof only: with no args the entry must reach argv parsing
// and print its "Usage: daemon-entry" error — a MODULE_NOT_FOUND or a missing
// usage line means the packaged graph does not load and the build must fail.
//
// resourcesDir is the packaged Resources dir (Contents/Resources on macOS,
// <appOutDir>/resources elsewhere). execPath defaults to the packaging Node.
function verifyPackagedDaemonEntryBoots(resourcesDir, options = {}) {
  const execPath = options.execPath || process.execPath
  const entryPath = assertPackagedDaemonEntryExists(resourcesDir)

  const result = spawnSync(execPath, [entryPath], { encoding: 'utf8', timeout: 10_000 })
  if (result.error) {
    throw new Error(
      `[verify-packaged-daemon-entry] could not launch daemon-entry.js: ${result.error.message}`
    )
  }
  const stderr = result.stderr || ''
  if (/Cannot find module|MODULE_NOT_FOUND/.test(stderr)) {
    throw new Error(
      `[verify-packaged-daemon-entry] packaged daemon-entry.js failed to load under plain Node:\n${stderr}`
    )
  }
  if (!stderr.includes('Usage: daemon-entry')) {
    throw new Error(
      `[verify-packaged-daemon-entry] packaged daemon-entry.js did not reach argv parsing ` +
        `(expected the "Usage: daemon-entry" error). stderr:\n${stderr}`
    )
  }
  console.log('[verify-packaged-daemon-entry] OK — packaged daemon-entry loads under plain Node')
}

const TERMINAL_HOST_BOOT_TIMEOUT_MS = 20_000
// Arithmetic so the shell echoing the typed command cannot satisfy the check.
const TERMINAL_HOST_BOOT_COMMAND = 'echo "OK $((6*7))" && exit'
const TERMINAL_HOST_BOOT_OUTPUT = 'OK 42'

/** The command prefix that runs a `targetArch` Mach-O here, or null when this host cannot. */
function macCommandPrefixForArch(targetArch, run = spawnSync) {
  if (targetArch === process.arch) {
    return []
  }
  if (targetArch === 'x64' && process.arch === 'arm64') {
    const rosetta = run('/usr/bin/arch', ['-x86_64', '/usr/bin/true'], { timeout: 10_000 })
    return rosetta.status === 0 ? ['/usr/bin/arch', '-x86_64'] : null
  }
  return null
}

/** One NDJSON daemon connection; resolves after a successful hello. */
function openDaemonConnection(socketPath, hello) {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath)
    const listeners = []
    let buffer = ''
    let greeted = false
    socket.setEncoding('utf8')
    socket.on('error', reject)
    socket.on('data', (chunk) => {
      buffer += chunk.toString()
      let newline
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const message = JSON.parse(buffer.slice(0, newline))
        buffer = buffer.slice(newline + 1)
        if (!greeted) {
          greeted = true
          if (message.ok) {
            resolve({ socket, onMessage: (listener) => listeners.push(listener) })
          } else {
            reject(new Error(`daemon rejected ${hello.role} hello: ${message.error}`))
          }
          continue
        }
        for (const listener of listeners) {
          listener(message)
        }
      }
    })
    socket.write(`${JSON.stringify({ type: 'hello', ...hello })}\n`)
  })
}

async function runTerminalHostRoundTrip({ command, entry, deadline, stderr }) {
  const scratch = mkdtempSync('/tmp/oth-')
  const socketPath = join(scratch, 'd.sock')
  const tokenPath = join(scratch, 'token')
  const env = { ...process.env, ORCA_USER_DATA_PATH: join(scratch, 'user-data') }
  delete env.ELECTRON_RUN_AS_NODE
  const daemon = spawn(
    command[0],
    [...command.slice(1), entry, '--socket', socketPath, '--token', tokenPath],
    { env, stdio: ['ignore', 'ignore', 'pipe'] }
  )
  daemon.stderr.setEncoding('utf8')
  daemon.stderr.on('data', (chunk) => stderr.push(chunk))
  let exited = false
  daemon.on('exit', () => {
    exited = true
  })
  daemon.on('error', (error) => stderr.push(error.message))
  const sockets = []
  const timers = new AbortController()
  try {
    // The first exec of a freshly signed binary can be slow while the system assesses it.
    while (!(existsSync(socketPath) && existsSync(tokenPath) && statSync(tokenPath).size > 0)) {
      if (exited || Date.now() > deadline) {
        throw new Error(exited ? 'the daemon exited before it was ready' : 'no daemon token')
      }
      await delay(100)
    }
    const token = readFileSync(tokenPath, 'utf8').trim()
    const clientId = randomUUID()
    const hello = { version: daemonProtocolVersion, token, clientId }
    const control = await openDaemonConnection(socketPath, { ...hello, role: 'control' })
    sockets.push(control.socket)
    const stream = await openDaemonConnection(socketPath, { ...hello, role: 'stream' })
    sockets.push(stream.socket)
    let output = ''
    const sawOutput = new Promise((resolve) => {
      stream.onMessage((message) => {
        output += message.payload?.data ?? ''
        if (output.includes(TERMINAL_HOST_BOOT_OUTPUT)) {
          resolve(true)
        }
      })
    })
    control.onMessage((message) => {
      if (message.id === 'boot-1' && message.ok === false) {
        stderr.push(`createOrAttach failed: ${message.error}`)
      }
    })
    control.socket.write(
      `${JSON.stringify({
        id: 'boot-1',
        type: 'createOrAttach',
        payload: {
          sessionId: 'terminal-host-boot',
          cols: 80,
          rows: 24,
          cwd: scratch,
          command: TERMINAL_HOST_BOOT_COMMAND
        }
      })}\n`
    )
    const remainingMs = Math.max(0, deadline - Date.now())
    const timeout = delay(remainingMs, false, { signal: timers.signal }).catch(() => false)
    const passed = await Promise.race([sawOutput, timeout])
    if (!passed) {
      throw new Error(
        `no "${TERMINAL_HOST_BOOT_OUTPUT}" from the PTY; output: ${output.slice(-400)}`
      )
    }
  } finally {
    timers.abort()
    for (const socket of sockets) {
      socket.destroy()
    }
    if (!exited) {
      daemon.kill('SIGTERM')
      const grace = new AbortController()
      await Promise.race([
        new Promise((resolve) => daemon.once('exit', resolve)),
        delay(3_000, undefined, { signal: grace.signal }).catch(() => {})
      ])
      grace.abort()
      if (!exited) {
        daemon.kill('SIGKILL')
      }
    }
    rmSync(scratch, { recursive: true, force: true })
  }
}

// Why: the helper's own Node must load node-pty and serve a PTY; a `Usage:` boot never loads
// node-pty. Release builds run it under hardened runtime, so allow-jit and same-team library
// validation are exercised before notarization.
async function verifyPackagedMacTerminalHostBoots(appPath, { arch }) {
  const paths = macTerminalHostPaths(appPath)
  const prefix = macCommandPrefixForArch(arch)
  if (!prefix) {
    console.log(
      `[verify-packaged-daemon-entry] skipped terminal host boot on ${arch} (host ${process.arch})`
    )
    return 'skipped'
  }
  const stderr = []
  try {
    await runTerminalHostRoundTrip({
      command: [...prefix, paths.executable],
      entry: paths.entry,
      deadline: Date.now() + TERMINAL_HOST_BOOT_TIMEOUT_MS,
      stderr
    })
  } catch (error) {
    throw new Error(
      `[verify-packaged-daemon-entry] the ${arch} terminal host did not serve a PTY: ${error.message}\n${stderr.join('').slice(-2000)}`
    )
  }
  console.log(`[verify-packaged-daemon-entry] OK — ${arch} terminal host served a PTY`)
  return 'booted'
}

module.exports = {
  assertPackagedDaemonEntryExists,
  macCommandPrefixForArch,
  verifyPackagedDaemonEntryBoots,
  verifyPackagedMacTerminalHostBoots
}
