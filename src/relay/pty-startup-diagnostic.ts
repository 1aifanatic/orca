import { createHash } from 'node:crypto'
import { closeSync, fstatSync, lstatSync, openSync, readFileSync, writeSync } from 'node:fs'

export const SSH_STARTUP_DIAGNOSTIC_RUN_ENV = 'ORCA_E2E_SSH_STARTUP_DIAGNOSTIC_RUN'
export const SSH_STARTUP_DIAGNOSTIC_LIMIT = 1_048_576

type StartupDiagnosticIdentity = {
  id: string
  incarnationId: string
  pid: number
  slavePath: string | null
  command: string | undefined
  providerDelivery: boolean
  waitForShellReady: boolean
}

type StartupDiagnosticEvent =
  | 'scheduled'
  | 'timer-fired'
  | 'timer-cleared'
  | 'prompt-ready'
  | 'shell-scan'
  | 'native-write-attempt'
  | 'native-write-returned'
  | 'native-write-threw'
  | 'native-output'
  | 'ingress-output'
  | 'native-exit'
  | 'disposed'

type StartupDiagnosticDetails = {
  delayMs?: number
  providerDelivery?: boolean
  shellPid?: number | null
  ready?: boolean
  exitCode?: number
  errorType?: string
  rawStartSeq?: number
  rawEndSeq?: number
  transformed?: boolean
  dataBase64?: string
  dataBytes?: number
}

export function sshStartupDiagnosticCommand(runId: string): string {
  const marker = `STA4067_STARTUP_READY_${runId}`
  const split = Math.floor(marker.length / 2)
  return `printf '%s|%s\\n' "$$" "$(tty)" > '/tmp/sta4067-${runId}.ledger'; printf '%s%s\\n' '${marker.slice(0, split)}' '${marker.slice(split)}'`
}

export class PtyStartupDiagnostic {
  private bytes = 0
  private sequence = 0
  private stopped = false
  private readonly started = process.hrtime.bigint()

  constructor(private readonly fd: number) {}

  record(event: StartupDiagnosticEvent, details: StartupDiagnosticDetails = {}): void {
    if (this.stopped) {
      return
    }
    this.append({ event, ...details })
  }

  output(event: 'native-output' | 'ingress-output', data: string): void {
    if (this.stopped) {
      return
    }
    const bytes = Buffer.byteLength(data)
    if (bytes > SSH_STARTUP_DIAGNOSTIC_LIMIT - this.bytes) {
      this.append({ event: 'capture-limit', omittedChunkBytes: bytes })
      this.close()
      return
    }
    this.record(event, { dataBytes: bytes, dataBase64: Buffer.from(data).toString('base64') })
  }

  write(payload: string, operation: () => void): void {
    this.record('native-write-attempt', {
      dataBytes: Buffer.byteLength(payload),
      dataBase64: Buffer.from(payload).toString('base64')
    })
    try {
      operation()
    } catch (error) {
      this.record('native-write-threw', {
        errorType: error instanceof Error ? error.name : typeof error
      })
      throw error
    }
    this.record('native-write-returned')
  }

  identity(identity: StartupDiagnosticIdentity): void {
    this.append({
      event: 'created',
      id: identity.id,
      incarnationId: identity.incarnationId,
      nativePid: identity.pid,
      slavePath: identity.slavePath,
      nativeStartTicks: readNativeStartTicks(identity.pid),
      command: identity.command,
      commandSha256: createHash('sha256')
        .update(identity.command ?? '')
        .digest('hex'),
      providerDelivery: identity.providerDelivery,
      waitForShellReady: identity.waitForShellReady
    })
  }

  close(): void {
    if (this.stopped) {
      return
    }
    this.stopped = true
    try {
      closeSync(this.fd)
    } catch {
      // Observation failure must not change terminal execution.
    }
  }

  private append(details: object): void {
    const row = `${JSON.stringify({
      sequence: ++this.sequence,
      elapsedNs: String(process.hrtime.bigint() - this.started),
      monotonicNs: String(process.hrtime.bigint()),
      ...details
    })}\n`
    const size = Buffer.byteLength(row)
    if (this.bytes + size > SSH_STARTUP_DIAGNOSTIC_LIMIT) {
      this.close()
      return
    }
    try {
      const buffer = Buffer.from(row)
      let offset = 0
      while (offset < buffer.length) {
        const written = writeSync(this.fd, buffer, offset)
        if (written <= 0) {
          throw new Error('Diagnostic write made no progress')
        }
        offset += written
      }
      this.bytes += size
    } catch {
      this.close()
    }
  }
}

function readNativeStartTicks(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? null
  } catch {
    return null
  }
}

export function createPtyStartupDiagnostic(
  runId: string | undefined,
  identity: StartupDiagnosticIdentity,
  platform: NodeJS.Platform = process.platform
): PtyStartupDiagnostic | undefined {
  if (
    platform !== 'linux' ||
    !runId ||
    !/^ssh_[0-9]{13}$/.test(runId) ||
    identity.command !== sshStartupDiagnosticCommand(runId)
  ) {
    return undefined
  }
  const directory = `/tmp/sta4067-diagnostic-${runId}`
  let fd: number | undefined
  try {
    const stat = lstatSync(directory)
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o077) !== 0
    ) {
      return undefined
    }
    fd = openSync(`${directory}/relay.jsonl`, 'wx', 0o600)
    const file = fstatSync(fd)
    if (!file.isFile() || file.uid !== stat.uid) {
      closeSync(fd)
      return undefined
    }
    const observer = new PtyStartupDiagnostic(fd)
    observer.identity(identity)
    return observer
  } catch {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        /* Retain ordinary terminal behavior. */
      }
    }
    return undefined
  }
}
