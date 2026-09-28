// The one process allowed to open this state directory's chat journal.
//
// Two Orca processes on one profile corrupt each other's chats: accepting a send and opening a
// chat both write without a lease, and each process mints sequence numbers from its own fold.
// Dev desktops skip the single-instance lock and share one profile, and a packaged build's lock
// lives in a `$TMPDIR` socket macOS purges (#7848). So the journal carries its own lock.
//
// The lock is a held `BEGIN EXCLUSIVE` on an empty SQLite file: a kernel byte-range lock that is
// refused while another process holds it and released when the holder dies, so there is no stale
// lock to clean up and no timeout to guess. The holder never writes, so the file stays empty.
//
// INVARIANT: in the owning process nothing but this connection may open or close a descriptor on
// the `.owner` file. A POSIX close of ANY descriptor on that inode drops every lock the process
// holds on it, so a copier that reads the file would silently hand ownership away.

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import Database from '../../sqlite/sync-database'
import { isTransientSqliteContention } from '../../sqlite/sqlite-read-failure'

export const JOURNAL_OWNER_LOCK_FILE = 'agent-session-journal.owner'

export class JournalOwnerLock {
  private held: Database | null

  constructor(
    readonly stateDirectory: string,
    connection: Database
  ) {
    this.held = connection
  }

  get isHeld(): boolean {
    return this.held !== null
  }

  /** Last, after the journal database is closed. Idempotent. */
  release(): void {
    const held = this.held
    this.held = null
    if (!held) {
      return
    }
    try {
      held.exec('ROLLBACK')
    } finally {
      held.close()
    }
  }
}

const RETRY_FIRST_DELAY_MS = 1_000
const RETRY_MAX_DELAY_MS = 30_000

/**
 * Keeps asking for the lock a peer holds, backing off from 1 s to 30 s. On Windows a dead
 * holder's lock is released only after an OS-timed delay, so one refusal is not the answer.
 * In memory only: it dies with the process or when cancelled.
 */
export function retryJournalOwnerLock(input: {
  stateDirectory: string
  onAcquired: (lock: JournalOwnerLock) => void
  onError?: (error: unknown) => void
  acquire?: (stateDirectory: string) => JournalOwnerLock | null
  schedule?: (run: () => void, delayMs: number) => { cancel: () => void }
}): { cancel: () => void } {
  const acquire = input.acquire ?? tryAcquireJournalOwnerLock
  const schedule = input.schedule ?? scheduleUnrefTimer
  let delayMs = RETRY_FIRST_DELAY_MS
  let cancelled = false
  let pending: { cancel: () => void } | null = null
  const attempt = (): void => {
    pending = null
    if (cancelled) {
      return
    }
    let lock: JournalOwnerLock | null = null
    try {
      lock = acquire(input.stateDirectory)
    } catch (error) {
      input.onError?.(error)
    }
    if (lock) {
      input.onAcquired(lock)
      return
    }
    delayMs = Math.min(delayMs * 2, RETRY_MAX_DELAY_MS)
    pending = schedule(attempt, delayMs)
  }
  pending = schedule(attempt, delayMs)
  return {
    cancel: () => {
      cancelled = true
      pending?.cancel()
      pending = null
    }
  }
}

function scheduleUnrefTimer(run: () => void, delayMs: number): { cancel: () => void } {
  const timer = setTimeout(run, delayMs)
  timer.unref?.()
  return { cancel: () => clearTimeout(timer) }
}

/** The lock, or null while another process holds it. Any other failure throws. */
export function tryAcquireJournalOwnerLock(stateDirectory: string): JournalOwnerLock | null {
  mkdirSync(stateDirectory, { recursive: true })
  // Why no pragma: the holder runs one statement, so it never sets `journal_mode` and can never
  // grow a `-wal` beside an empty file. `timeout: 0` makes a held lock refuse at once.
  const connection = new Database(join(stateDirectory, JOURNAL_OWNER_LOCK_FILE), { timeout: 0 })
  try {
    connection.exec('BEGIN EXCLUSIVE')
    return new JournalOwnerLock(stateDirectory, connection)
  } catch (error) {
    connection.close()
    if (isTransientSqliteContention(error)) {
      return null
    }
    throw error
  }
}
