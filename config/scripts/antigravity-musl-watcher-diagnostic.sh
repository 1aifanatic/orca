#!/usr/bin/env bash
set -euo pipefail
cat > "$DIAGNOSTIC_DIR/source-attestation.mjs" <<'ATTESTATION'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const json = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)

export function packageManagerIdentity(source, expected) {
  const bytes = readFileSync(join(source, 'package.json'))
  const packageManager = JSON.parse(bytes).packageManager
  if (packageManager !== expected.packageManager) {
    throw new Error('package manager differs from exact matrix source pin')
  }
  return { packageManager, packageJsonSha256: hash(bytes) }
}

export function sourceIdentity(source, evidence, env, label, expected) {
  const git = (...args) =>
    execFileSync('git', ['-c', `safe.directory=${source}`, '-C', source, ...args], {
      env,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024
    }).trim()
  const commit = git('rev-parse', 'HEAD')
  const tree = git('rev-parse', 'HEAD^{tree}')
  if (commit !== expected.sha || tree !== expected.tree) {
    throw new Error('checkout SHA/tree does not match exact matrix source')
  }
  git('diff', '--no-ext-diff', '--exit-code', 'HEAD', '--')
  const tracked = git('ls-files', '--stage', '-z').split('\0').filter(Boolean)
  const files = tracked.map((item) => {
    const [metadata, path] = item.split('\t')
    const [mode, object, stage] = metadata.split(' ')
    if (stage !== '0') {
      throw new Error(`unmerged path ${path}`)
    }
    const file = join(source, path)
    const bytes = lstatSync(file).isSymbolicLink()
      ? Buffer.from(readlinkSync(file))
      : readFileSync(file)
    const blob = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
    if (blob !== object) {
      throw new Error(`source bytes differ from Git object: ${path}`)
    }
    return { path, mode, object, sha256: hash(bytes), bytes: bytes.length }
  })
  const lockHash = hash(readFileSync(join(source, 'pnpm-lock.yaml')))
  if (lockHash !== expected.lock) {
    throw new Error('lockfile hash differs from pinned matrix source')
  }
  const manager = packageManagerIdentity(source, expected)
  const identity = {
    commit,
    tree,
    parents: git('show', '-s', '--format=%P', 'HEAD'),
    lockHash,
    ...manager,
    files
  }
  json(join(evidence, `source-${label}.json`), identity)
  return hash(Buffer.from(JSON.stringify(files)))
}
ATTESTATION
cat > "$DIAGNOSTIC_DIR/private-process-environment.mjs" <<'ENVIRONMENT'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export function privateEnvironment(root, toolDirectory) {
  const nonce = randomUUID()
  const state = join(root, `private-${nonce}`)
  for (const dir of ['home', 'config', 'cache', 'data', 'state', 'runtime', 'temp', 'userData']) {
    mkdirSync(join(state, dir), { recursive: true, mode: 0o700 })
  }
  writeFileSync(join(state, 'owner'), nonce, { flag: 'wx' })
  return {
    PATH: `${toolDirectory}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
    HOME: join(state, 'home'),
    USERPROFILE: join(state, 'home'),
    APPDATA: join(state, 'config'),
    LOCALAPPDATA: join(state, 'config'),
    XDG_CONFIG_HOME: join(state, 'config'),
    XDG_CACHE_HOME: join(state, 'cache'),
    XDG_DATA_HOME: join(state, 'data'),
    XDG_STATE_HOME: join(state, 'state'),
    XDG_RUNTIME_DIR: join(state, 'runtime'),
    TMPDIR: join(state, 'temp'),
    TMP: join(state, 'temp'),
    TEMP: join(state, 'temp'),
    ORCA_USER_DATA: join(state, 'userData'),
    ORCA_BACKGROUND_LAUNCH: '1',
    ORCA_DIAGNOSTIC_NONCE: nonce,
    CI: '1',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(state, 'home', '.gitconfig'),
    npm_config_userconfig: join(state, 'home', '.npmrc'),
    npm_config_globalconfig: join(state, 'home', 'global.npmrc'),
    npm_config_cache: join(state, 'cache', 'npm')
  }
}

export function verifyChildEnvironment(child, expected) {
  if (process.platform !== 'linux') {
    return { verified: true, method: 'explicit fork environment; /proc unavailable' }
  }
  const actual = Object.fromEntries(
    readFileSync(`/proc/${child.pid}/environ`, 'utf8')
      .split('\0')
      .filter(Boolean)
      .map((entry) => {
        const i = entry.indexOf('=')
        return [entry.slice(0, i), entry.slice(i + 1)]
      })
  )
  const matched = Object.keys(expected).every((key) => actual[key] === expected[key])
  const unexpectedKeys = Object.keys(actual).filter(
    (key) =>
      !Object.hasOwn(expected, key) &&
      !['NODE_CHANNEL_FD', 'NODE_CHANNEL_SERIALIZATION_MODE'].includes(key)
  )
  const status = readFileSync(`/proc/${child.pid}/status`, 'utf8')
  const parentPid = Number(/^PPid:\s+(\d+)/m.exec(status)?.[1])
  return {
    verified: matched && unexpectedKeys.length === 0 && parentPid === process.pid,
    method: 'own native PID /proc environ and PPid',
    pid: child.pid,
    parentPid,
    matchedEnvironment: Object.fromEntries(Object.keys(expected).map((key) => [key, actual[key]])),
    unexpectedKeys
  }
}
ENVIRONMENT
cat > "$DIAGNOSTIC_DIR/diagnostic.mjs" <<'DIAGNOSTIC'
import { privateEnvironment, verifyChildEnvironment } from './private-process-environment.mjs'
import { packageManagerIdentity, sourceIdentity } from './source-attestation.mjs'
import { fork, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const runtimeHash = '2cd83acecc7693ce96bcb4e292ff4c80461b7490028a002abe5a28ac9892bc29'
const nativeHash = 'fea0cee2d578a5aa62c6cdceb61bc4392031d5a3c37a75afb4a3e109a99061f6'
const watcherArchiveHash = '05afd8e3d424da6aa8b77905fa65d0ef99d3ccb7a66fea4cae896a0e3ec33b26'
const image =
  'node:24.21.0-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1'
const json = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')

export async function packageManagerArchive(evidence, pin) {
  const [version, integrity] = pin.slice('pnpm@'.length).split('+sha512.')
  const url = `https://registry.npmjs.org/pnpm/-/pnpm-${version}.tgz`
  const file = join(evidence, 'package-manager.tgz')
  let bytes
  if (existsSync(file)) {
    bytes = readFileSync(file)
  } else {
    const response = await fetch(url, { signal: AbortSignal.timeout(120_000) })
    if (!response.ok) throw new Error(`package manager download returned ${response.status}`)
    bytes = Buffer.from(await response.arrayBuffer())
  }
  const sha512 = createHash('sha512').update(bytes).digest('hex')
  if (sha512 !== integrity) throw new Error('package manager archive differs from exact source pin')
  writeFileSync(file, bytes)
  json(join(evidence, 'package-manager-identity.json'), { pin, url, sha512, sha256: hash(bytes) })
  return file
}

export function outputCollectors(root, overflow, { maxBytes = 1_048_576, tailBytes = 16_384, recordBytes = 16_384 } = {}) {
  if (![maxBytes, tailBytes, recordBytes].every((value) => Number.isSafeInteger(value) && value > 0)) {
    throw new Error('invalid diagnostic output byte limit')
  }
  const collector = (name, wholeRecords = false) => {
    const file = join(root, name)
    const tailFile = file + '.tail'
    const meta = { maxBytes, tailBytes, totalBytes: 0, prefixBytes: 0, suffixBytes: 0, chunks: 0, droppedPrefixBytes: 0, oversizedRecords: 0, truncatedRecordBytes: 0, overflow: false, wholeRecords }
    let tail = Buffer.alloc(0)
    let tailRecords = []
    writeFileSync(file, '')
    writeFileSync(tailFile, '')
    const update = () => json(file + '.metadata.json', meta)
    update()
    const write = (raw) => {
      const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
      meta.totalBytes += bytes.length
      meta.chunks++
      const remaining = maxBytes - meta.prefixBytes
      const keep = wholeRecords && bytes.length > remaining ? 0 : Math.min(bytes.length, remaining)
      if (keep > 0) appendFileSync(file, bytes.subarray(0, keep))
      meta.prefixBytes += keep
      meta.droppedPrefixBytes += bytes.length - keep
      if (wholeRecords) {
        tailRecords.push(bytes)
        while (tailRecords.reduce((total, item) => total + item.length, 0) > tailBytes) tailRecords.shift()
        tail = Buffer.concat(tailRecords)
      } else {
        tail = Buffer.concat([tail, bytes.subarray(Math.max(0, bytes.length - tailBytes))]).subarray(-tailBytes)
      }
      meta.suffixBytes = tail.length
      writeFileSync(tailFile, tail)
      if (meta.droppedPrefixBytes > 0 && !meta.overflow) {
        meta.overflow = true
        overflow(name)
      }
      update()
    }
    const record = (value) => {
      let line = JSON.stringify(value) + '\n'
      const bytes = Buffer.byteLength(line)
      if (bytes > Math.min(recordBytes, tailBytes)) {
        meta.oversizedRecords++
        const small = (value) => typeof value === 'string' ? value.slice(0, 256) :
          value === null || ['undefined', 'number', 'boolean'].includes(typeof value) ? value : '[non-scalar]'
        const result = value.result
        line = JSON.stringify({
          seq: value.seq, elapsedNs: value.elapsedNs, type: value.type, event: value.event, time: value.time,
          code: value.code, signal: value.signal, state: value.state, pid: value.pid,
          message: typeof value.message === 'object' && value.message !== null
            ? { op: small(value.message.op), id: small(value.message.id) } : small(value.message),
          result: result && { code: result.code, signal: result.signal, exited: result.exited, closed: result.closed, timedOut: result.timedOut, streamTimedOut: result.streamTimedOut, cleanup: result.cleanup, outputOverflow: result.outputOverflow, firstError: small(result.errors[0]), errorCount: result.errorCount ?? result.errors.length },
          originalBytes: bytes, recordSha256: hash(Buffer.from(line)), truncated: true
        }) + '\n'
        meta.truncatedRecordBytes += Math.max(0, bytes - Buffer.byteLength(line))
        if (!meta.overflow) { meta.overflow = true; overflow(name) }
      }
      write(line)
    }
    return { write, record, metadata: () => ({ ...meta }) }
  }
  const stdout = collector('stdout.log')
  const stderr = collector('stderr.log')
  const events = collector('events.jsonl', true)
  return { stdout, stderr, events, metadata: () => ({ stdout: stdout.metadata(), stderr: stderr.metadata(), events: events.metadata() }) }
}

function recordError(result, value) {
  const bytes = Buffer.from(String(value))
  result.errorCount = (result.errorCount ?? 0) + 1
  let message = bytes.subarray(0, 2_048).toString('utf8')
  while (Buffer.byteLength(message) > 2_048) message = message.slice(0, -1)
  if (result.errors.length < 16) result.errors.push(message)
  else result.errorsOmitted = (result.errorsOmitted ?? 0) + 1
  if (bytes.length > 2_048 || result.errorsOmitted) result.outputOverflow = true
}


export function strictSuccess(result) {
  return (
    result.subscribed === true &&
    result.code === 0 &&
    result.signal === null &&
    result.exited === true &&
    result.closed === true &&
    result.disconnected === true &&
    result.timedOut === false &&
    result.outputOverflow === false &&
    result.errors.length === 0 &&
    result.environmentVerified === true &&
    result.cleanup === 'exited' &&
    (!result.requireUnsubscribe || result.unsubscribed === true) &&
    (!result.requireCanary || result.canaryObserved === true)
  )
}

export function caseAccepted(kind, result) {
  if (kind === 'invalid-root') {
    return (
      !strictSuccess(result) &&
      result.subscribeFailed === true &&
      !result.subscribed &&
      result.code === 0 &&
      result.signal === null &&
      result.exited &&
      result.closed &&
      result.disconnected &&
      !result.timedOut &&
      !result.outputOverflow &&
      result.errors.length === 0 &&
      result.environmentVerified &&
      result.cleanup === 'exited'
    )
  }
  if (kind === 'intentional-host-termination') {
    return (
      !strictSuccess(result) &&
      result.subscribed &&
      result.hostTerminated &&
      result.code === null &&
      result.signal === 'SIGTERM' &&
      result.exited &&
      result.closed &&
      !result.timedOut &&
      !result.outputOverflow &&
      result.errors.length === 0 &&
      result.environmentVerified &&
      result.cleanup === 'exited'
    )
  }
  return strictSuccess(result)
}

export function diagnosticSuccess(summary) {
  const kinds = [
    'exact-disconnect',
    'unsubscribe-disconnect',
    'configured-canary',
    'invalid-root',
    'intentional-host-termination'
  ]
  return (
    !summary.error &&
    !summary.preservationError &&
    summary.sourcePreserved === true &&
    ['tool', 'install', 'build'].every((name) => summary.stages[name]?.ok === true) &&
    summary.cases.length === kinds.length &&
    kinds.every(
      (kind, index) =>
        summary.cases[index].kind === kind && caseAccepted(kind, summary.cases[index])
    )
  )
}

// Mirrors build-orcad's shipped-child subscribe/disconnect probe without changing its bytes.
export async function runCase({ evidence, entry, runtime, kind, deadline = 30_000, outputLimits = {} }) {
  const root = join(evidence, 'cases', `${kind}-${randomUUID()}`)
  mkdirSync(root, { recursive: true })
  const env = privateEnvironment(root, join(evidence, 'tools', 'bin'))
  const state = resolve(env.HOME, '..')
  const watchRoot = join(state, 'watched')
  mkdirSync(watchRoot)
  if (kind === 'configured-canary') {
    env.ORCA_WATCHER_CANARY_DIR = join(state, 'canary')
    mkdirSync(env.ORCA_WATCHER_CANARY_DIR)
  }
  const started = process.hrtime.bigint()
  let seq = 0
  const event = (type, data = {}) => {
    outputs.events.record({ seq: ++seq, elapsedNs: String(process.hrtime.bigint() - started), type, ...data })
    json(join(root, 'result.json'), result)
  }
  const result = {
    kind,
    subscribed: false,
    subscribeFailed: false,
    unsubscribed: false,
    disconnected: false,
    hostTerminated: false,
    canaryObserved: false,
    requireUnsubscribe: kind === 'unsubscribe-disconnect',
    requireCanary: kind === 'configured-canary',
    code: null,
    signal: null,
    exited: false,
    closed: false,
    timedOut: false,
    outputOverflow: false,
    errors: [],
    environmentVerified: false,
    cleanup: 'unverifiable'
  }
  const outputs = outputCollectors(root, () => {
    result.outputOverflow = true
    json(join(root, 'result.json'), result)
  }, outputLimits)
  json(join(root, 'launch.json'), {
    entry,
    runtime,
    environment: env,
    deadline,
    parentPid: process.pid
  })
  event('launch')
  const child = fork(entry, [], {
    execPath: runtime,
    execArgv: [],
    cwd: state,
    env,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true
  })
  json(join(root, 'owned-pid.json'), {
    pid: child.pid,
    parentPid: process.pid,
    nonce: env.ORCA_DIAGNOSTIC_NONCE
  })
  event('fork', { pid: child.pid })
  child.stdout?.on('data', (data) => outputs.stdout.write(data))
  child.stderr?.on('data', (data) => outputs.stderr.write(data))
  let canaryTimer
  const send = (message) => {
    event('send', { message })
    child.send(message, (error) => {
      if (error) {
        recordError(result, error.message)
        event('send-error', { message: error.message })
      }
    })
  }
  const disconnect = () => {
    if (result.disconnected) {
      recordError(result, 'duplicate disconnect request')
      return
    }
    result.disconnected = true
    event('disconnect-request')
    if (child.connected) {
      child.disconnect()
    } else {
      recordError(result, 'IPC closed before requested disconnect')
    }
  }
  await new Promise((settle) => {
    let finished = false
    const finish = () => {
      if (finished) {
        return
      }
      finished = true
      clearTimeout(timer)
      clearTimeout(hardTimer)
      clearInterval(canaryTimer)
      settle()
    }
    const timer = setTimeout(() => {
      result.timedOut = true
      event('timeout')
      child.kill('SIGKILL')
    }, deadline)
    const hardTimer = setTimeout(finish, deadline + 5_000)
    const closedStreams = new Set()
    const complete = () => {
      result.closed = closedStreams.size === 2
      if (result.exited && result.closed) {
        finish()
      }
    }
    for (const [name, stream] of [
      ['stdout', child.stdout],
      ['stderr', child.stderr]
    ]) {
      stream?.once('close', () => {
        closedStreams.add(name)
        event(`${name}-close`)
        complete()
      })
    }
    child.on('disconnect', () => event('IPC-disconnect'))
    child.on('error', (error) => {
      recordError(result, error.message)
      event('error', { message: error.message })
    })
    child.on('exit', (code, signal) => {
      Object.assign(result, { code, signal, exited: true })
      event('exit', { code, signal })
      complete()
    })
    child.on('close', (code, signal) => {
      event('close', { code, signal })
      if (result.errors.length > 0 && !result.exited) {
        finish()
      }
    })
    child.on('message', (message) => {
      event('message', { message })
      if (!message || message.id !== 1 || typeof message.op !== 'string') {
        recordError(result, 'unexpected watcher protocol message')
        return
      }
      if (message.op === 'subscribe-failed') {
        result.subscribeFailed = true
        disconnect()
        return
      }
      if (message.op === 'unsubscribed') {
        result.unsubscribed = true
        if (kind !== 'unsubscribe-disconnect') {
          recordError(result, 'unexpected unsubscribe acknowledgement')
        }
        disconnect()
        return
      }
      if (
        ['watch-error', 'unsubscribe-failed', 'overflow', 'cancel-requires-restart'].includes(
          message.op
        )
      ) {
        recordError(result, `watcher ${message.op}: ${message.message ?? ''}`)
        disconnect()
        return
      }
      if (message.op !== 'subscribed') {
        if (!['subscribe-started', 'events'].includes(message.op)) {
          recordError(result, `unknown operation ${message.op}`)
        }
        return
      }
      if (result.subscribed) {
        recordError(result, 'duplicate subscribe acknowledgement')
        return
      }
      result.subscribed = true
      try {
        const binding = verifyChildEnvironment(child, env)
        result.environmentVerified = binding.verified
        json(join(root, 'actual-child-environment.json'), binding)
        event('environment-bound', { verified: binding.verified })
      } catch (error) {
        recordError(result, error.message)
      }
      if (kind === 'unsubscribe-disconnect') {
        send({ op: 'unsubscribe', id: 1 })
        return
      }
      if (kind === 'intentional-host-termination') {
        result.hostTerminated = true
        event('host-termination-request', { signal: 'SIGTERM' })
        child.kill('SIGTERM')
        return
      }
      if (kind === 'configured-canary') {
        canaryTimer = setInterval(() => {
          if (existsSync(join(env.ORCA_WATCHER_CANARY_DIR, 'canary.txt'))) {
            result.canaryObserved = true
            event('configured-canary-write')
            clearInterval(canaryTimer)
            disconnect()
          }
        }, 50)
        return
      }
      disconnect()
    })
    child.once('spawn', () => {
      if (kind === 'invalid-root') {
        try {
          const binding = verifyChildEnvironment(child, env)
          result.environmentVerified = binding.verified
          json(join(root, 'actual-child-environment.json'), binding)
        } catch (error) {
          recordError(result, error.message)
        }
      }
      send({
        op: 'subscribe',
        id: 1,
        dir: kind === 'invalid-root' ? join(state, 'missing-root') : watchRoot,
        opts: {}
      })
    })
  })
  if (
    result.exited &&
    result.closed &&
    readFileSync(join(state, 'owner'), 'utf8') === env.ORCA_DIAGNOSTIC_NONCE
  ) {
    rmSync(state, { recursive: true })
    result.cleanup = existsSync(state) ? 'unverifiable' : 'exited'
  }
  event('cleanup', { state: result.cleanup })
  result.outputs = outputs.metadata()
  result.strictSuccess = strictSuccess(result)
  result.expectedNegative = ['invalid-root', 'intentional-host-termination'].includes(kind)
  result.accepted = caseAccepted(kind, result)
  json(join(root, 'result.json'), result)
  return result
}

export async function command({ evidence, source, tools, name, program, args, deadline, streamWait = 1_000, outputLimits = {}, printResult = true }) {
  const root = join(evidence, 'commands', name)
  mkdirSync(root, { recursive: true })
  const env = privateEnvironment(root, tools)
  json(join(root, 'command.json'), { program, args, cwd: source, environment: env, deadline })
  const result = {
    code: null,
    signal: null,
    timedOut: false,
    outputOverflow: false,
    errors: [],
    exited: false,
    closed: false,
    streamTimedOut: false,
    cleanup: 'unverifiable'
  }
  const saveResult = () => {
    const file = join(root, 'result.json')
    json(file + '.pending', result)
    renameSync(file + '.pending', file)
  }
  const outputs = outputCollectors(root, () => {
    result.outputOverflow = true
    result.ok = false
    saveResult()
  }, outputLimits)
  const persist = (event, details = {}) => {
    saveResult()
    outputs.events.record({ event, time: Date.now(), ...details, result })
  }
  persist('pending')
  let child
  await new Promise((settle) => {
    child = spawn(program, args, {
      cwd: source,
      env,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    json(join(root, 'owned-pid.json'), { pid: child.pid, nonce: env.ORCA_DIAGNOSTIC_NONCE })
    child.stdout?.on('data', (data) => outputs.stdout.write(data))
    child.stderr?.on('data', (data) => outputs.stderr.write(data))
    let streamTimer
    let finished = false
    const signalOwnedGroup = () => {
      if (!Number.isSafeInteger(child.pid)) return
      try {
        if (process.platform === 'win32') {
          child.kill('SIGKILL')
        } else {
          process.kill(-child.pid, 'SIGKILL')
        }
        persist('cleanup-signal', { pid: child.pid, signal: 'SIGKILL' })
      } catch (error) {
        if (error.code !== 'ESRCH') recordError(result, error.message)
        persist('cleanup-signal-error', { error: error.message })
      }
    }
    const closeOwnedPipes = () => {
      result.streamTimedOut = true
      persist('stream-timeout')
      signalOwnedGroup()
      child.stdout?.destroy()
      child.stderr?.destroy()
    }
    const finish = () => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      clearTimeout(hardTimer)
      clearTimeout(streamTimer)
      persist('settled')
      settle()
    }
    const timer = setTimeout(() => {
      result.timedOut = true
      persist('timeout')
      signalOwnedGroup()
      clearTimeout(streamTimer)
      streamTimer = setTimeout(closeOwnedPipes, streamWait)
    }, deadline)
    const hardTimer = setTimeout(() => {
      result.timedOut = true
      persist('hard-timeout')
      signalOwnedGroup()
      closeOwnedPipes()
      finish()
    }, deadline + streamWait + 1_000)
    child.on('spawn', () => persist('spawn', { pid: child.pid }))
    child.on('error', (error) => {
      recordError(result, error.message)
      persist('error')
    })
    child.on('exit', (code, signal) => {
      if (!result.exited) Object.assign(result, { code, signal, exited: true })
      persist('exit')
      if (!streamTimer) streamTimer = setTimeout(closeOwnedPipes, streamWait)
    })
    child.on('close', () => {
      result.closed = true
      persist('close')
      finish()
    })
  })
  let groupExited = result.exited
  if (groupExited && process.platform !== 'win32') {
    try {
      process.kill(-child.pid, 0)
      groupExited = false
    } catch (error) {
      groupExited = error.code === 'ESRCH'
      if (!groupExited) recordError(result, error.message)
    }
  }
  const state = resolve(env.HOME, '..')
  if (groupExited && result.closed && !result.streamTimedOut &&
    readFileSync(join(state, 'owner'), 'utf8') === env.ORCA_DIAGNOSTIC_NONCE) {
    rmSync(state, { recursive: true })
    result.cleanup = existsSync(state) ? 'unverifiable' : 'exited'
  }
  persist('cleanup', { groupExited })
  result.outputs = outputs.metadata()
  result.ok =
    result.code === 0 &&
    result.signal === null &&
    result.exited &&
    result.closed &&
    !result.timedOut &&
      !result.outputOverflow &&
    !result.streamTimedOut &&
    result.errors.length === 0 &&
    result.cleanup === 'exited'
  persist('final')
  result.outputs = outputs.metadata()
  saveResult()
  if (printResult) console.log(JSON.stringify({ command: name, ...result }))
  return result
}

export async function main(source, evidence, expected) {
  const tools = join(evidence, 'tools', 'bin')
  const summary = {
    source: expected,
    image,
    platform: 'linux/amd64',
    runtimeHash,
    status: 'failed',
    nativeVerified: false,
    stages: {},
    cases: [],
    isolation:
      'fresh private state and environment whitelist; no provider, hook endpoint, trust RPC or server startup'
  }
  const finish = () => json(join(evidence, 'final-status.json'), summary)
  finish()
  let before
  try {
    before = sourceIdentity(
      source,
      evidence,
      privateEnvironment(join(evidence, 'identity-before'), tools),
      'before',
      expected
    )
    const { NODE_RUNTIME_PIN, NODE_RUNTIME_ASSETS } = await import(
      pathToFileURL(join(source, 'src/shared/node-runtime-pin.ts'))
    )
    const asset = NODE_RUNTIME_ASSETS['linux-x64-musl']
    if (NODE_RUNTIME_PIN.version !== '24.21.0' || asset.executableSha256 !== runtimeHash) {
      throw new Error('source runtime pin changed')
    }
    json(join(evidence, 'runtime-source-pin.json'), { version: NODE_RUNTIME_PIN.version, asset })
    const { packageManager } = packageManagerIdentity(source, expected)
    const managerArchive = await packageManagerArchive(evidence, packageManager)
    const run = (name, program, args, deadline) =>
      command({ evidence, source, tools, name, program, args, deadline })
    summary.stages.tool = await run(
      'install-pnpm',
      'npm',
      ['install', '--global', '--prefix', join(evidence, 'tools'), managerArchive],
      120_000
    )
    if (!summary.stages.tool.ok) {
      throw new Error('pnpm tool installation failed')
    }
    summary.stages.install = await run(
      'pnpm-install',
      join(tools, 'pnpm'),
      [
        'install',
        '--frozen-lockfile',
        '--ignore-scripts',
        '--store-dir',
        join(evidence, 'pnpm-store')
      ],
      480_000
    )
    if (!summary.stages.install.ok) {
      throw new Error('original frozen dependency installation failed')
    }
    summary.stages.build = await run(
      'original-build-orcad',
      join(tools, 'pnpm'),
      ['build:orcad'],
      480_000
    )
    const out = join(source, 'out', 'orcad')
    const { packagedNodeRuntimePath } = await import(
      pathToFileURL(join(source, 'config/scripts/build-orcad-node.mjs'))
    )
    const runtime = packagedNodeRuntimePath(out, 'linux-x64-musl')
    const entry = join(out, 'parcel-watcher-process-entry.js')
    const native = join(out, 'node_modules', '@parcel', 'watcher', 'watcher.node')
    const wrapper = join(out, 'node_modules', '@parcel', 'watcher', 'index.js')
    const require = createRequire(join(source, 'package.json'))
    const { version } = require('@parcel/watcher/package.json')
    const { parseWatcherLockfile, watcherPackageIdentity, verifyWatcherArchive } = await import(
      pathToFileURL(join(source, 'config/scripts/orcad-watcher-package.mjs'))
    )
    const parcel = watcherPackageIdentity(
      'linux-x64-musl',
      version,
      parseWatcherLockfile(readFileSync(join(source, 'pnpm-lock.yaml'), 'utf8'))
    )
    if (version !== '2.5.6' || hash(readFileSync(runtime)) !== runtimeHash) {
      throw new Error('shipped native/runtime pins differ')
    }
    const cache = join(source, 'out', '.orcad-watchers', version, 'linux-x64-musl')
    const archive = readFileSync(join(cache, 'package.tgz'))
    verifyWatcherArchive(archive, parcel.integrity)
    if (hash(archive) !== watcherArchiveHash || hash(readFileSync(native)) !== nativeHash) {
      throw new Error('locked musl watcher artifact SHA256 differs from the fresh byte attestation')
    }
    if (hash(readFileSync(native)) !== hash(readFileSync(join(cache, 'package', 'watcher.node')))) {
      throw new Error('shipped native bytes differ from locked artifact')
    }
    json(join(evidence, 'artifact-identities.json'), {
      version,
      parcel,
      archiveSha256: hash(archive),
      files: Object.fromEntries(
        [runtime, entry, native, wrapper].map((path) => [
          path,
          { sha256: hash(readFileSync(path)), bytes: lstatSync(path).size }
        ])
      )
    })
    for (const kind of [
      'exact-disconnect',
      'unsubscribe-disconnect',
      'configured-canary',
      'invalid-root',
      'intentional-host-termination'
    ]) {
      summary.cases.push(await runCase({ evidence, entry, runtime, kind }))
      finish()
    }
  } catch (error) {
    summary.error = error.stack
  }
  try {
    if (before) {
      summary.sourcePreserved =
        sourceIdentity(
          source,
          evidence,
          privateEnvironment(join(evidence, 'identity-after'), tools),
          'after',
          expected
        ) === before
    }
  } catch (error) {
    summary.preservationError = error.stack
  }
  summary.nativeVerified = diagnosticSuccess(summary)
  summary.status = summary.nativeVerified ? 'passed' : 'failed'
  finish()
  return summary.nativeVerified ? 0 : 1
}

export async function bootstrap(source, evidence, expected, options = {}) {
  const summary = {
    source: expected, status: 'failed', ok: false, nativeVerified: false,
    diagnosticRan: false, stages: {}, errors: [], outputOverflow: false
  }
  const save = () => {
    const file = join(evidence, 'bootstrap.result.json')
    json(file + '.pending', summary)
    renameSync(file + '.pending', file)
  }
  save()
  try {
    const common = { evidence, source, tools: join(evidence, 'tools', 'bin'), printResult: false, streamWait: options.streamWait ?? 1_000 }
    summary.stages.apk = await command({
      ...common, name: 'bootstrap-apk', program: options.apkProgram ?? 'apk',
      args: options.apkArgs ?? ['add', '--no-cache', 'bash', 'git', 'libstdc++', 'python3', 'make', 'g++'],
      deadline: options.apkDeadline ?? 180_000
    })
    save()
    if (summary.stages.apk.ok) {
      summary.diagnosticRan = true
      save()
      summary.stages.diagnostic = await command({
        ...common, name: 'bootstrap-diagnostic', program: options.diagnosticProgram ?? process.execPath,
        args: options.diagnosticArgs ?? [join(evidence, 'diagnostic.mjs'), source, evidence, expected.sha, expected.tree, expected.lock, expected.packageManager],
        deadline: options.diagnosticDeadline ?? 1_050_000
      })
      save()
      const inner = JSON.parse(readFileSync(join(evidence, 'final-status.json'), 'utf8'))
      summary.innerObservedStatus = inner.status
      summary.innerObservedNativeVerified = inner.nativeVerified
      summary.ok = summary.stages.diagnostic.ok && inner.status === 'passed' &&
        inner.nativeVerified === true && diagnosticSuccess(inner)
      summary.nativeVerified = summary.ok
      summary.status = summary.ok ? 'passed' : 'failed'
    }
  } catch (error) {
    recordError(summary, error.message)
  } finally {
    save()
    const file = join(evidence, 'final-status.json')
    const inner = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { source: expected, status: 'failed', nativeVerified: false }
    inner.bootstrap = summary
    if (!summary.ok) {
      inner.status = 'failed'
      inner.nativeVerified = false
    }
    json(file, inner)
  }
  return summary
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const mode = process.argv[2]
  if (mode === '--bounded-preflight') {
    const [source, evidence, ...pins] = process.argv.slice(3)
    const result = await command({
      source, evidence, tools: '/usr/local/bin', name: 'preflight',
      program: process.execPath,
      args: [resolve(process.argv[1]), '--preflight', source, evidence, ...pins],
      deadline: 150_000, printResult: false
    })
    process.exitCode = result.ok ? 0 : 1
  } else if (mode === '--bootstrap') {
    const [source, evidence, sha, tree, lock, packageManager] = process.argv.slice(3)
    const result = await bootstrap(source, evidence, { sha, tree, lock, packageManager })
    process.exitCode = result.ok ? 0 : 1
  } else if (mode === '--host-docker' || mode === '--host-container') {
    const [source, evidence, program, ...args] = process.argv.slice(3)
    const container = mode === '--host-container'
    const name = container ? 'container-run' : 'host-docker-' + randomUUID()
    const root = join(evidence, 'commands', name)
    const result = await command({
      evidence, source, tools: '/usr/local/bin', name, program,
      args: container ? args : ['--config', join(evidence, 'host-private', 'docker'), '--host', 'unix:///var/run/docker.sock', ...args],
      deadline: container ? 1_280_000 : 120_000, printResult: false
    })
    json(join(evidence, container ? 'container.result.json' : name + '.result.json'), result)
    if (!container) {
      process.stdout.write(readFileSync(join(root, 'stdout.log')))
      process.stderr.write(readFileSync(join(root, 'stderr.log')))
    }
    if (container && !result.ok) {
      const file = join(evidence, 'final-status.json')
      const summary = JSON.parse(readFileSync(file, 'utf8'))
      summary.innerObservedStatus = summary.status
      summary.innerObservedNativeVerified = summary.nativeVerified
      summary.containerObserver = result
      summary.status = 'failed'
      summary.nativeVerified = false
      json(file, summary)
    }
    process.exitCode = result.ok ? 0 : 1
  } else {
  const preflight = process.argv[2] === '--preflight'
  const [source, evidence, sha, tree, lock, packageManager] = process.argv.slice(preflight ? 3 : 2)
  const expected = { sha, tree, lock, packageManager }
  if (preflight) {
    sourceIdentity(source, evidence, privateEnvironment(join(evidence, 'preflight'), ''), 'preflight', expected)
    await packageManagerArchive(evidence, packageManager)
  } else {
    process.exitCode = await main(source, evidence, expected)
  }
  }
}
DIAGNOSTIC
cat > "$DIAGNOSTIC_DIR/bootstrap.sh" <<'BOOTSTRAP'
#!/bin/sh
set -eu
diagnostic_source="${5:-/source}"
diagnostic_evidence="${6:-/evidence}"
exec node "$diagnostic_evidence/diagnostic.mjs" --bootstrap "$diagnostic_source" "$diagnostic_evidence" "$1" "$2" "$3" "$4"
BOOTSTRAP
for dir in home config cache data state runtime temp userData; do
  mkdir -p "$DIAGNOSTIC_DIR/bootstrap-private/$dir"
done
sha256sum "$DIAGNOSTIC_DIR/diagnostic.mjs" "$DIAGNOSTIC_DIR/source-attestation.mjs" \
  "$DIAGNOSTIC_DIR/private-process-environment.mjs" "$DIAGNOSTIC_DIR/bootstrap.sh" > "$DIAGNOSTIC_DIR/observer.sha256"
diagnostic_host_node="$(command -v node)"
preflight_argv=(env -i PATH=/usr/local/bin:/usr/bin:/bin HOME="$HOME" USERPROFILE="$USERPROFILE" \
  APPDATA="$APPDATA" LOCALAPPDATA="$LOCALAPPDATA" XDG_CONFIG_HOME="$XDG_CONFIG_HOME" \
  XDG_CACHE_HOME="$XDG_CACHE_HOME" XDG_DATA_HOME="$XDG_DATA_HOME" XDG_STATE_HOME="$XDG_STATE_HOME" \
  XDG_RUNTIME_DIR="$XDG_RUNTIME_DIR" TMPDIR="$TMPDIR" TMP="$TMPDIR" TEMP="$TMPDIR" \
  ORCA_USER_DATA="$APPDATA/orca" ORCA_BACKGROUND_LAUNCH=1 ORCA_DIAGNOSTIC_NONCE="$DIAGNOSTIC_NONCE" \
  CI=1 GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL="$HOME/.gitconfig" \
  "$diagnostic_host_node" "$DIAGNOSTIC_DIR/diagnostic.mjs" --bounded-preflight "$GITHUB_WORKSPACE/source" "$DIAGNOSTIC_DIR" \
  "${DIAGNOSTIC_SHA}" "${DIAGNOSTIC_TREE}" "${DIAGNOSTIC_LOCK}" "${DIAGNOSTIC_PACKAGE_MANAGER}")
printf '%s\n' "${preflight_argv[@]}" > "$DIAGNOSTIC_DIR/preflight.argv.txt"
set +e
"${preflight_argv[@]}"
preflight_code=$?
set -e
printf '{"code":%s}\n' "$preflight_code" > "$DIAGNOSTIC_DIR/preflight.wrapper-result.json"
if [ "$preflight_code" -ne 0 ]; then exit "$preflight_code"; fi
