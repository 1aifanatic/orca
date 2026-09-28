import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdirSync,
  chmodSync,
  openSync,
  readSync,
  readdirSync,
  unlinkSync,
  watch,
  type FSWatcher
} from 'node:fs'
import { join } from 'node:path'

import { isAgentHookSource, type AgentHookSource } from './agent-hook-relay'
import { buildSpoolHookBody, drainAgentHookSpool, launchTokenHash } from './agent-hook-spool'
import {
  AGENT_HOOK_INBOX_DIR_NAME,
  AGENT_HOOK_INBOX_MAX_PAYLOAD_CHARS,
  AGENT_HOOK_INBOX_RECORD_SUFFIX,
  endsWithAgentHookInboxRecordEnd,
  parseAgentHookInboxRecord,
  type AgentHookInboxRecord
} from './agent-hook-inbox-record'

/** Why: the sweep, not the watcher, guarantees delivery; a platform watcher can arm and then
 *  deliver nothing. The watcher only makes delivery faster than this. */
export const AGENT_HOOK_INBOX_SWEEP_MS = 1_000
/** A record still unterminated this long after its last write belongs to a killed writer. */
export const AGENT_HOOK_INBOX_TORN_RECORD_MAX_AGE_MS = 10 * 60 * 1000
/** Same replay horizon as the legacy spool and last-status hydration. */
export const AGENT_HOOK_INBOX_MAX_RECORD_AGE_MS = 7 * 24 * 60 * 60 * 1000
const MAX_RECORD_FILE_BYTES = AGENT_HOOK_INBOX_MAX_PAYLOAD_CHARS * 4 + 64 * 1024
const RECORD_TAIL_PROBE_BYTES = 32
const RECORD_NAME = /^(\d+)\.(\d+)\.rec$/

export type AgentHookInboxIngest = (
  record: AgentHookInboxRecord,
  meta: { isReplay: boolean }
) => void

type PendingRecord = { name: string; path: string; mtimeMs: number; pid: number; seq: number }

export function agentHookInboxDir(endpointDir: string): string {
  return join(endpointDir, AGENT_HOOK_INBOX_DIR_NAME)
}

export type CommittedHookIngest = (
  source: AgentHookSource,
  body: Record<string, unknown>,
  meta: { isReplay: boolean }
) => void

/**
 * Takes ownership of every hook event committed to disk for one endpoint: replays the legacy
 * spool (still written by hook scripts from an older Orca) and the inbox backlog, then keeps the
 * inbox draining live. Returns null when the inbox cannot be owned; the caller must then not
 * advertise it, so hook scripts keep POSTing.
 */
export function openAgentHookInbox(options: {
  endpointDir: string
  ingest: CommittedHookIngest
  /** Launch the host last saw for a pane; a replay from any other launch is stale. */
  persistedLaunchTokenHash?: (paneKey: string) => string | undefined
}): AgentHookInbox | null {
  const isStaleReplay = (paneKey: unknown, launchToken: unknown): boolean => {
    const expected =
      typeof paneKey === 'string' ? options.persistedLaunchTokenHash?.(paneKey) : undefined
    return (
      Boolean(expected) &&
      launchTokenHash(typeof launchToken === 'string' ? launchToken : undefined) !== expected
    )
  }
  const ingest = (source: string, body: Record<string, unknown>, isReplay: boolean): void => {
    if (isAgentHookSource(source) && !(isReplay && isStaleReplay(body.paneKey, body.launchToken))) {
      options.ingest(source, body, { isReplay })
    }
  }
  try {
    drainAgentHookSpool({
      endpointDir: options.endpointDir,
      getPersistedLaunchTokenHash: () => undefined,
      ingest: (record) => ingest(record.source, buildSpoolHookBody(record), true)
    })
  } catch (error) {
    // Why: a replay failure must not stop the host from starting; the spool stays for next time.
    console.error('[agent-hooks] spool replay failed:', error)
  }
  const inbox = new AgentHookInbox(
    agentHookInboxDir(options.endpointDir),
    ({ source, body }, { isReplay }) => ingest(source, body, isReplay)
  )
  if (!inbox.open()) {
    return null
  }
  inbox.drain()
  return inbox
}

/**
 * Owns one endpoint's hook inbox: managed hook scripts commit one file per event, and this
 * drains them in commit order through the same ingest the HTTP listener uses.
 *
 * A record is claimed by unlinking it: only a successful unlink admits it, so a record is
 * ingested at most once however many drains race. Records already present when the inbox
 * opens were committed while nothing was draining and are replays; everything later is live.
 */
export class AgentHookInbox {
  private watcher: FSWatcher | null = null
  private sweepTimer: ReturnType<typeof setInterval> | null = null
  private wakeScheduled = false
  private draining = false
  private drainAgain = false
  private replayNames = new Set<string>()
  private isOpen = false

  constructor(
    private readonly dir: string,
    private readonly ingest: AgentHookInboxIngest,
    private readonly now: () => number = Date.now
  ) {}

  get path(): string {
    return this.dir
  }

  /** Arms the watcher and sweep, then snapshots the backlog as replays. Returns false when the
   *  directory is not private to this user; the caller must then not advertise the inbox. */
  open(): boolean {
    if (this.isOpen) {
      return true
    }
    if (!ensurePrivateDirectory(this.dir)) {
      return false
    }
    try {
      // Why: armed before the backlog scan, so a record committed between the scan and arming
      // cannot wait for the sweep (the previous run's endpoint file already advertises us).
      this.watcher = watch(this.dir, { persistent: false }, () => this.scheduleDrain())
      this.watcher.on('error', () => this.closeWatcher())
    } catch {
      this.watcher = null
    }
    this.sweepTimer = setInterval(() => this.drain(), AGENT_HOOK_INBOX_SWEEP_MS)
    this.sweepTimer.unref?.()
    this.replayNames = new Set(listRecordNames(this.dir))
    this.isOpen = true
    return true
  }

  close(): void {
    this.isOpen = false
    this.closeWatcher()
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer)
      this.sweepTimer = null
    }
    this.replayNames.clear()
  }

  /** Synchronously ingests every complete record in commit order. Callers that decide a pane's
   *  fate (process exit, retirement, interrupt inference) call this first, so an event the agent
   *  committed before that moment is applied before it, as the old blocking POST guaranteed. */
  drain(): void {
    if (!this.isOpen) {
      return
    }
    if (this.draining) {
      // Why: an ingest listener re-entered a decision point; the outer pass picks up the rest.
      this.drainAgain = true
      return
    }
    this.draining = true
    try {
      do {
        this.drainAgain = false
        this.drainOnce()
      } while (this.drainAgain && this.isOpen)
    } finally {
      this.draining = false
    }
  }

  private scheduleDrain(): void {
    if (this.wakeScheduled) {
      return
    }
    this.wakeScheduled = true
    setImmediate(() => {
      this.wakeScheduled = false
      this.drain()
    })
  }

  private closeWatcher(): void {
    try {
      this.watcher?.close()
    } catch {
      // already closed
    }
    this.watcher = null
  }

  private drainOnce(): void {
    const pending: PendingRecord[] = []
    for (const name of listRecordNames(this.dir)) {
      const path = join(this.dir, name)
      let mtimeMs: number
      try {
        const stat = lstatSync(path)
        if (!stat.isFile()) {
          continue
        }
        mtimeMs = stat.mtimeMs
      } catch {
        continue
      }
      const match = RECORD_NAME.exec(name)
      pending.push({
        name,
        path,
        mtimeMs,
        pid: match ? Number(match[1]) : 0,
        seq: match ? Number(match[2]) : 0
      })
    }
    // Why numeric pid/seq after mtime: coarse mtime clocks tie fast sequential hooks, and a
    // lexical sort would put pid 999 after pid 1000.
    pending.sort((a, b) => a.mtimeMs - b.mtimeMs || a.pid - b.pid || a.seq - b.seq)
    const now = this.now()
    for (const entry of pending) {
      if (!this.isOpen) {
        return
      }
      this.admit(entry, now)
    }
  }

  private admit(entry: PendingRecord, now: number): void {
    const bytes = readCompleteRecord(entry.path)
    if (bytes === 'incomplete') {
      if (now - entry.mtimeMs > AGENT_HOOK_INBOX_TORN_RECORD_MAX_AGE_MS) {
        claim(entry.path)
        this.replayNames.delete(entry.name)
      }
      return
    }
    if (!claim(entry.path)) {
      return
    }
    const isReplay = this.replayNames.delete(entry.name)
    if (bytes === 'invalid' || now - entry.mtimeMs > AGENT_HOOK_INBOX_MAX_RECORD_AGE_MS) {
      return
    }
    const parsed = parseAgentHookInboxRecord(bytes)
    if (parsed.kind !== 'complete') {
      return
    }
    try {
      this.ingest(parsed.record, { isReplay })
    } catch (error) {
      // Why: one bad record must not wedge the records committed after it.
      console.error('[agent-hooks] hook inbox record ingest failed:', error)
    }
  }
}

function listRecordNames(dir: string): string[] {
  try {
    return readdirSync(dir).filter((name) => name.endsWith(AGENT_HOOK_INBOX_RECORD_SUFFIX))
  } catch {
    return []
  }
}

/** Only a successful unlink owns the record; ENOENT means another drain took it, and EPERM/EBUSY
 *  (Windows scanners holding the file) means try again on the next pass. */
function claim(path: string): boolean {
  try {
    unlinkSync(path)
    return true
  } catch {
    return false
  }
}

function readCompleteRecord(path: string): Buffer | 'incomplete' | 'invalid' {
  let fd: number
  try {
    // Why O_NOFOLLOW: the inbox is private, but a record must never read through a link.
    fd = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
  } catch {
    return 'incomplete'
  }
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > MAX_RECORD_FILE_BYTES) {
      return 'invalid'
    }
    // Why probe the tail first: a record still being written is common under load, and reading
    // a large unfinished payload on every wake would be wasted work.
    const tailLength = Math.min(stat.size, RECORD_TAIL_PROBE_BYTES)
    const tail = Buffer.alloc(tailLength)
    readSync(fd, tail, 0, tailLength, stat.size - tailLength)
    if (!endsWithAgentHookInboxRecordEnd(tail)) {
      return 'incomplete'
    }
    const bytes = Buffer.alloc(stat.size)
    let offset = 0
    while (offset < bytes.length) {
      const read = readSync(fd, bytes, offset, bytes.length - offset, offset)
      if (read === 0) {
        return 'incomplete'
      }
      offset += read
    }
    return bytes
  } catch {
    return 'incomplete'
  } finally {
    closeSync(fd)
  }
}

function ensurePrivateDirectory(dir: string): boolean {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const stat = lstatSync(dir)
    if (!stat.isDirectory()) {
      return false
    }
    if (process.platform === 'win32') {
      return true
    }
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
      return false
    }
    if ((stat.mode & 0o077) !== 0) {
      chmodSync(dir, 0o700)
    }
    return true
  } catch {
    return false
  }
}
