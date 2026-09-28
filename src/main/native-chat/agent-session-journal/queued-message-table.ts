// Host-owned draft rows for messages queued while the main agent is working.
//
// A queued message is NOT a journal row: it becomes one — an ordinary
// submission — only when consume converts it, in the same transaction as the
// submission's append. Until then it lives here, `session_id`-keyed so it
// survives epoch rollover and replacement (`journal-row-table.ts` deletes only
// `journal_rows`), and after a refusal its text survives as a `returned` row a
// rewind cannot delete.

import type Database from '../../sqlite/sync-database'
import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'

export type QueuedMessageState = 'waiting' | 'dispatched' | 'returned' | 'withdrawn'

export type QueuedMessageRow = {
  sessionId: string
  messageId: string
  position: number
  body: AgentJournalMessageItem
  fingerprint: string
  createdAt: number
  hostInstance: string
  state: QueuedMessageState
  returnedReason: string | null
  settledAt: number | null
  /** The operation ledger's caller-scoped key, making settled rows mutation receipts. */
  settledByOp: string | null
  /** The draft's current submission when it differs from `messageId` (a returned-card re-send). */
  consumedAs: string | null
}

/**
 * Created idempotently at EVERY writable open, never lazily at first insert, so
 * no reader hits "no such table". Deliberately no `user_version` bump: an old
 * build sees stored == supported and stays writable, ignoring the table; a bump
 * would latch every opened db read-only after a downgrade (`journal-database.ts`).
 */
export function ensureQueuedMessagesTable(db: Database.Database): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS queued_messages (
  session_id      TEXT    NOT NULL,
  message_id      TEXT    NOT NULL,
  position        INTEGER NOT NULL,
  body_json       TEXT    NOT NULL,
  fingerprint     TEXT    NOT NULL,
  created_at      INTEGER NOT NULL,
  host_instance   TEXT    NOT NULL,
  state           TEXT    NOT NULL,
  returned_reason TEXT,
  settled_at      INTEGER,
  settled_by_op   TEXT,
  consumed_as     TEXT,
  PRIMARY KEY (session_id, message_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS queued_messages_consumed_as
  ON queued_messages (session_id, consumed_as) WHERE consumed_as IS NOT NULL;
`)
}

const COLUMNS =
  'session_id, message_id, position, body_json, fingerprint, created_at, host_instance, state, returned_reason, settled_at, settled_by_op, consumed_as'

export function insertQueuedMessage(
  db: Database.Database,
  input: {
    sessionId: string
    messageId: string
    body: AgentJournalMessageItem
    fingerprint: string
    hostInstance: string
    now: number
  }
): QueuedMessageRow {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the statement selects exactly one aliased numeric column; better-sqlite3 types rows as unknown.
  const highest = db
    .prepare('SELECT COALESCE(MAX(position), 0) AS p FROM queued_messages WHERE session_id = ?')
    .get(input.sessionId) as { p?: number } | undefined
  const position = Number(highest?.p ?? 0) + 1
  db.prepare(
    `INSERT INTO queued_messages (${COLUMNS})
     VALUES (?, ?, ?, ?, ?, ?, ?, 'waiting', NULL, NULL, NULL, NULL)`
  ).run(
    input.sessionId,
    input.messageId,
    position,
    JSON.stringify(input.body),
    input.fingerprint,
    input.now,
    input.hostInstance
  )
  return {
    sessionId: input.sessionId,
    messageId: input.messageId,
    position,
    body: input.body,
    fingerprint: input.fingerprint,
    createdAt: input.now,
    hostInstance: input.hostInstance,
    state: 'waiting',
    returnedReason: null,
    settledAt: null,
    settledByOp: null,
    consumedAs: null
  }
}

export function listQueuedMessages(db: Database.Database, sessionId: string): QueuedMessageRow[] {
  const rows = db
    .prepare(`SELECT ${COLUMNS} FROM queued_messages WHERE session_id = ? ORDER BY position ASC`)
    .all(sessionId)
  const parsed: QueuedMessageRow[] = []
  for (const row of rows) {
    const stored = toStoredRow(row)
    if (stored) {
      parsed.push(stored)
    }
  }
  return parsed
}

export function getQueuedMessage(
  db: Database.Database,
  sessionId: string,
  messageId: string
): QueuedMessageRow | null {
  const row = db
    .prepare(`SELECT ${COLUMNS} FROM queued_messages WHERE session_id = ? AND message_id = ?`)
    .get(sessionId, messageId)
  return row === undefined ? null : toStoredRow(row)
}

/**
 * The one waiting→dispatched (or returned→dispatched, for a re-send under a
 * fresh submission id) transition. MUST run inside the caller's transaction —
 * the journal writer's, between BEGIN IMMEDIATE and COMMIT — so a failed
 * submission append rolls the consume back and a failed consume rolls the
 * append back. Returns false when the draft was not in the expected state, in
 * which case the caller throws to abort the append.
 */
export function consumeQueuedMessageInTransaction(
  db: Database.Database,
  input: {
    sessionId: string
    messageId: string
    expect: 'waiting' | 'returned'
    /** The fresh submission id of a returned-card re-send; the draft id otherwise. */
    consumedAs: string
    settledByOp: string | null
    now: number
  }
): boolean {
  const consumedAs = input.consumedAs === input.messageId ? null : input.consumedAs
  const changed = db
    .prepare(
      `UPDATE queued_messages
       SET state = 'dispatched', settled_at = ?, settled_by_op = ?, consumed_as = ?
       WHERE session_id = ? AND message_id = ? AND state = ?`
    )
    .run(input.now, input.settledByOp, consumedAs, input.sessionId, input.messageId, input.expect)
  return Number(changed.changes ?? 0) === 1
}

/** Compare-and-transition the withdrawable set (waiting ∪ returned) to withdrawn
 *  tombstones stamped with the operation's caller-scoped key. Returns the rows
 *  actually transitioned, with the bodies the caller returns to the user. */
export function withdrawQueuedMessages(
  db: Database.Database,
  input: { sessionId: string; messageIds: readonly string[]; settledByOp: string; now: number }
): QueuedMessageRow[] {
  const withdrawn: QueuedMessageRow[] = []
  for (const messageId of input.messageIds) {
    const row = getQueuedMessage(db, input.sessionId, messageId)
    if (!row || (row.state !== 'waiting' && row.state !== 'returned')) {
      continue
    }
    db.prepare(
      `UPDATE queued_messages
       SET state = 'withdrawn', settled_at = ?, settled_by_op = ?
       WHERE session_id = ? AND message_id = ? AND state IN ('waiting', 'returned')`
    ).run(input.now, input.settledByOp, input.sessionId, messageId)
    withdrawn.push({
      ...row,
      state: 'withdrawn',
      settledAt: input.now,
      settledByOp: input.settledByOp
    })
  }
  return withdrawn
}

/**
 * dispatched → returned, matched on the draft's CURRENT submission relation
 * (`COALESCE(consumed_as, message_id)`), so a re-send refused again still
 * returns while a late duplicate of the original refusal matches nothing.
 */
export function returnDispatchedQueuedMessage(
  db: Database.Database,
  input: { sessionId: string; consumedRef: string; reason: string | null; now: number }
): boolean {
  const changed = db
    .prepare(
      `UPDATE queued_messages
       SET state = 'returned', returned_reason = ?, settled_at = ?
       WHERE session_id = ? AND state = 'dispatched' AND COALESCE(consumed_as, message_id) = ?`
    )
    .run(input.reason, input.now, input.sessionId, input.consumedRef)
  return Number(changed.changes ?? 0) > 0
}

/** Replay receipts: every row a given caller-scoped operation settled. */
export function queuedMessagesSettledByOp(
  db: Database.Database,
  sessionId: string,
  settledByOp: string
): QueuedMessageRow[] {
  const rows = db
    .prepare(
      `SELECT ${COLUMNS} FROM queued_messages
       WHERE session_id = ? AND settled_by_op = ? ORDER BY position ASC`
    )
    .all(sessionId, settledByOp)
  const parsed: QueuedMessageRow[] = []
  for (const row of rows) {
    const stored = toStoredRow(row)
    if (stored) {
      parsed.push(stored)
    }
  }
  return parsed
}

/** What the loaded journal says about a dispatched draft's consumed submission. */
export type QueuedMessageSubmissionVerdict =
  /** Still owed an answer — a crash leftover the delivery loop will reject; keep the row. */
  | 'pending'
  /** `accepted` or `unknown`: terminal and not refused. */
  | 'terminal-not-refused'
  /** Absent from the current epoch. */
  | 'absent'
  /** Effectively rejected; the open-time repair returns it rather than pruning. */
  | 'rejected'

/**
 * Retention: `withdrawn` tombstones live for the operation-replay window;
 * a `dispatched` row only once its consumed submission is terminal-and-not-
 * refused or absent AND the window has passed — never while pending, so a slow
 * refusal can still return it. `waiting` and `returned` rows are never pruned.
 */
export function pruneQueuedMessages(
  db: Database.Database,
  input: {
    sessionId: string
    now: number
    replayWindowMs: number
    submissionVerdict: (consumedRef: string) => QueuedMessageSubmissionVerdict
  }
): void {
  const cutoff = input.now - input.replayWindowMs
  db.prepare(
    `DELETE FROM queued_messages
     WHERE session_id = ? AND state = 'withdrawn' AND settled_at IS NOT NULL AND settled_at < ?`
  ).run(input.sessionId, cutoff)
  for (const row of listQueuedMessages(db, input.sessionId)) {
    if (row.state !== 'dispatched' || row.settledAt === null || row.settledAt >= cutoff) {
      continue
    }
    const verdict = input.submissionVerdict(row.consumedAs ?? row.messageId)
    if (verdict === 'terminal-not-refused' || verdict === 'absent') {
      db.prepare('DELETE FROM queued_messages WHERE session_id = ? AND message_id = ?').run(
        input.sessionId,
        row.messageId
      )
    }
  }
}

function toStoredRow(row: unknown): QueuedMessageRow | null {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: rows come from this file's own SELECTs, which name exactly these columns; better-sqlite3 types them as unknown.
  const record = row as {
    session_id: string
    message_id: string
    position: number
    body_json: string
    fingerprint: string
    created_at: number
    host_instance: string
    state: string
    returned_reason: string | null
    settled_at: number | null
    settled_by_op: string | null
    consumed_as: string | null
  }
  let body: AgentJournalMessageItem
  try {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: body_json is written only by insertQueuedMessage from a schema-validated AgentJournalMessageItem.
    body = JSON.parse(record.body_json) as AgentJournalMessageItem
  } catch {
    // Our own writer stringified it; an unreadable body is corruption, and a
    // row we cannot re-materialize must not masquerade as an empty message.
    return null
  }
  const state = record.state
  if (
    state !== 'waiting' &&
    state !== 'dispatched' &&
    state !== 'returned' &&
    state !== 'withdrawn'
  ) {
    return null
  }
  return {
    sessionId: record.session_id,
    messageId: record.message_id,
    position: record.position,
    body,
    fingerprint: record.fingerprint,
    createdAt: record.created_at,
    hostInstance: record.host_instance,
    state,
    returnedReason: record.returned_reason,
    settledAt: record.settled_at,
    settledByOp: record.settled_by_op,
    consumedAs: record.consumed_as
  }
}
