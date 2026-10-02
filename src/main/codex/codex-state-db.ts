import type { CodexStateDbBackfillStatus } from '../foreign-sqlite-readers/codex-index-status-result'
import { readCodexIndexStatus } from '../foreign-sqlite-readers/foreign-sqlite-reader-spawn'

// Why async: every read here (state DB open, sessions-tree walk) runs on the
// foreign SQLite reader worker, so a large -wal or a stalled \\wsl.localhost
// share never blocks the main thread. There is no main-thread fallback.

export type { CodexStateDbBackfillStatus }

export const BACKFILL_PENDING_MIN_SESSION_FILES = 100

export type CodexStateDbBackfillSnapshot = {
  status: CodexStateDbBackfillStatus
  /** Rollouts counted up to the requested limit; null unless status is `missing` or `not-tracked`. */
  sessionFileCount: number | null
}

function workerUnansweredStatus(): CodexStateDbBackfillStatus {
  return {
    kind: 'unreadable',
    stateDbPath: null,
    error: 'The Codex index reader did not answer'
  }
}

/**
 * Backfill status plus a bounded rollout count, in one worker round trip.
 * @returns Null when the reader worker did not answer, which is not an unreadable index.
 */
export async function readCodexStateDbBackfillSnapshot(
  codexHomePath: string,
  sessionFileLimit: number
): Promise<CodexStateDbBackfillSnapshot | null> {
  const answer = await readCodexIndexStatus({
    type: 'backfill',
    codexHomePath,
    sessionFileLimit
  })
  return answer ? { status: answer.status, sessionFileCount: answer.sessionFileCount } : null
}

/** Reads Codex-owned backfill metadata without creating or mutating its database. */
export async function readCodexStateDbBackfillStatus(
  codexHomePath: string
): Promise<CodexStateDbBackfillStatus> {
  const snapshot = await readCodexStateDbBackfillSnapshot(codexHomePath, 0)
  return snapshot?.status ?? workerUnansweredStatus()
}

/**
 * Lower-cased thread ids already in Codex's state DB, or null when the DB is
 * missing or unreadable. Read-only; never creates or mutates Codex's database.
 */
export async function readIndexedCodexThreadIds(
  codexHomePath: string
): Promise<Set<string> | null> {
  const answer = await readCodexIndexStatus({ type: 'indexedThreadIds', codexHomePath })
  if (answer?.error) {
    console.warn('[codex-state-db] Failed to read indexed Codex threads:', answer.error)
  }
  return answer?.threadIds ? new Set(answer.threadIds) : null
}

/** Rollouts under `sessionsRoot`, counted up to `limit`; 0 when the reader cannot answer. */
export async function countCodexSessionFilesUpTo(
  sessionsRoot: string,
  limit: number
): Promise<number> {
  const answer = await readCodexIndexStatus({ type: 'sessionFileCount', sessionsRoot, limit })
  return answer?.count ?? 0
}

/** Pending from a snapshot; an unanswered read is not pending, as an unreadable index is not. */
export function isCodexStateDbBackfillSnapshotPending(
  snapshot: CodexStateDbBackfillSnapshot | null
): boolean {
  if (!snapshot) {
    return false
  }
  if (snapshot.status.kind === 'incomplete') {
    return true
  }
  return (snapshot.sessionFileCount ?? 0) >= BACKFILL_PENDING_MIN_SESSION_FILES
}

export async function isCodexStateDbBackfillPending(codexHomePath: string): Promise<boolean> {
  return isCodexStateDbBackfillSnapshotPending(
    await readCodexStateDbBackfillSnapshot(codexHomePath, BACKFILL_PENDING_MIN_SESSION_FILES)
  )
}
