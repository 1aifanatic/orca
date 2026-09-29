// Host-owned draft rows for messages queued while the main agent is working.
//
// A queued message is NOT a journal row: it becomes one — an ordinary
// submission — only when consume converts it, in the same transaction as the
// submission's append. Until then it lives here, `session_id`-keyed so it
// survives epoch rollover and replacement (`journal-row-table.ts` deletes only
// `journal_rows`), and after a refusal its text survives as a `returned` row a
// rewind cannot delete.

import type Database from '../../sqlite/sync-database'
import type { UnreadAgentSessionFailureFact } from '../../../shared/agent-session-failure'
import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import { readStoredRejectionFact } from './journal-dispatch-reducer'

export type QueuedMessageState = 'waiting' | 'dispatched' | 'returned' | 'withdrawn'

/** Why a waiting draft is held from auto-sending. Stored on the row — the hold
 *  must survive handle eviction and restart, and it dies with the session's
 *  journal. Both values are wire markers (they publish as `pausedReason`);
 *  a reader treats an unknown value as a plain hold. */
export type QueuedMessageHoldReason = 'stopped' | 'send_failed'

/** Definitively unsettled: what Stop, /clear, Edit and the budget count, and
 *  what the published list shows. Pending/unknown/accepted deliveries and
 *  tombstones stay outside it. */
export function isUnsettledQueuedMessage(row: Pick<QueuedMessageRow, 'state'>): boolean {
  return row.state === 'waiting' || row.state === 'returned'
}

export type QueuedMessageRow = {
  sessionId: string
  messageId: string
  position: number
  body: AgentJournalMessageItem
  fingerprint: string
  createdAt: number
  hostInstance: string
  state: QueuedMessageState
  /** Non-null holds a waiting draft from auto-sending; typed values in
   *  `QueuedMessageHoldReason`, unknown strings read as a plain hold. */
  holdReason: string | null
  /** A returned card's refusal, mirroring its submission's `reason` and `rejection` pair. */
  returnedReason: string | null
  returnedRejection: UnreadAgentSessionFailureFact | null
  settledAt: number | null
  /** The operation ledger's caller-scoped key, making settled rows mutation receipts. */
  settledByOp: string | null
  /** The draft's current submission when it differs from `messageId` (a returned-card re-send). */
  consumedAs: string | null
}

const COLUMNS =
  'session_id, message_id, position, body_json, fingerprint, created_at, host_instance, state, hold_reason, returned_reason, returned_rejection, settled_at, settled_by_op, consumed_as'

export function insertQueuedMessage(
  db: Database.Database,
  input: {
    sessionId: string
    messageId: string
    body: AgentJournalMessageItem
    fingerprint: string
    hostInstance: string
    now: number
    /** Insert already held (a /clear carrying drafts across sessions): the row
     *  must never be visible unheld, or the drain could send it first. */
    holdReason?: QueuedMessageHoldReason
  }
): QueuedMessageRow {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the statement selects exactly one aliased numeric column; better-sqlite3 types rows as unknown.
  const highest = db
    .prepare('SELECT COALESCE(MAX(position), 0) AS p FROM queued_messages WHERE session_id = ?')
    .get(input.sessionId) as { p?: number } | undefined
  const position = Number(highest?.p ?? 0) + 1
  db.prepare(
    `INSERT INTO queued_messages (${COLUMNS})
     VALUES (?, ?, ?, ?, ?, ?, ?, 'waiting', ?, NULL, NULL, NULL, NULL, NULL)`
  ).run(
    input.sessionId,
    input.messageId,
    position,
    JSON.stringify(input.body),
    input.fingerprint,
    input.now,
    input.hostInstance,
    input.holdReason ?? null
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
    holdReason: input.holdReason ?? null,
    returnedReason: null,
    returnedRejection: null,
    settledAt: null,
    settledByOp: null,
    consumedAs: null
  }
}

/** Hold waiting drafts from auto-sending (a Stop, a failed conversion). The
 *  hold retires with the row: consume and withdraw clear it in their own
 *  UPDATE. Returns how many rows the hold newly reached. */
export function holdQueuedMessages(
  db: Database.Database,
  input: {
    sessionId: string
    messageIds: readonly string[]
    reason: QueuedMessageHoldReason
  }
): number {
  const update = db.prepare(
    `UPDATE queued_messages SET hold_reason = ?
     WHERE session_id = ? AND message_id = ? AND state = 'waiting'
       AND (hold_reason IS NULL OR hold_reason <> ?)`
  )
  let held = 0
  for (const messageId of input.messageIds) {
    held += Number(update.run(input.reason, input.sessionId, messageId, input.reason).changes ?? 0)
  }
  return held
}

/** Lift the stop-shaped holds once a user send starts its turn: a stored
 *  'stopped' (Stop, /clear carry) and the DERIVED restart hold — that row is
 *  adopted into the current host instance, the same fact the derivation reads,
 *  so no second copy exists. `send_failed` and unknown markers stay: they
 *  release only through an explicit Send. Returns how many rows it lifted. */
export function releaseStopShapedQueuedMessageHolds(
  db: Database.Database,
  input: { sessionId: string; hostInstance: string }
): number {
  return Number(
    db
      .prepare(
        `UPDATE queued_messages SET hold_reason = NULL, host_instance = ?
         WHERE session_id = ? AND state = 'waiting'
           AND (hold_reason = 'stopped' OR (hold_reason IS NULL AND host_instance <> ?))`
      )
      .run(input.hostInstance, input.sessionId, input.hostInstance).changes ?? 0
  )
}

export function listQueuedMessages(db: Database.Database, sessionId: string): QueuedMessageRow[] {
  return db
    .prepare(`SELECT ${COLUMNS} FROM queued_messages WHERE session_id = ? ORDER BY position ASC`)
    .all(sessionId)
    .flatMap((row) => toStoredRow(row) ?? [])
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
       SET state = 'dispatched', hold_reason = NULL, settled_at = ?, settled_by_op = ?, consumed_as = ?
       WHERE session_id = ? AND message_id = ? AND state = ?`
    )
    .run(input.now, input.settledByOp, consumedAs, input.sessionId, input.messageId, input.expect)
  return Number(changed.changes ?? 0) === 1
}

/** Compare-and-transition unsettled rows (waiting ∪ returned) to withdrawn
 *  tombstones stamped with the operation's caller-scoped key, kept only so a
 *  replay of the settling operation answers "spent". Returns the rows actually
 *  transitioned; their text stays in this database, never on the wire. */
export function withdrawQueuedMessages(
  db: Database.Database,
  input: { sessionId: string; messageIds: readonly string[]; settledByOp: string; now: number }
): QueuedMessageRow[] {
  const withdrawn: QueuedMessageRow[] = []
  for (const messageId of input.messageIds) {
    const row = getQueuedMessage(db, input.sessionId, messageId)
    if (!row || !isUnsettledQueuedMessage(row)) {
      continue
    }
    db.prepare(
      `UPDATE queued_messages
       SET state = 'withdrawn', hold_reason = NULL, settled_at = ?, settled_by_op = ?
       WHERE session_id = ? AND message_id = ? AND state IN ('waiting', 'returned')`
    ).run(input.now, input.settledByOp, input.sessionId, messageId)
    withdrawn.push({
      ...row,
      state: 'withdrawn',
      holdReason: null,
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
  input: {
    sessionId: string
    consumedRef: string
    reason: string | null
    rejection: UnreadAgentSessionFailureFact | undefined
    now: number
  }
): boolean {
  const changed = db
    .prepare(
      `UPDATE queued_messages
       SET state = 'returned', returned_reason = ?, returned_rejection = ?, settled_at = ?
       WHERE session_id = ? AND state = 'dispatched' AND COALESCE(consumed_as, message_id) = ?`
    )
    .run(
      input.reason,
      input.rejection ? JSON.stringify(input.rejection) : null,
      input.now,
      input.sessionId,
      input.consumedRef
    )
  return Number(changed.changes ?? 0) > 0
}

/** Replay receipts: every row a given caller-scoped operation settled. */
export function queuedMessagesSettledByOp(
  db: Database.Database,
  sessionId: string,
  settledByOp: string
): QueuedMessageRow[] {
  return db
    .prepare(
      `SELECT ${COLUMNS} FROM queued_messages
       WHERE session_id = ? AND settled_by_op = ? ORDER BY position ASC`
    )
    .all(sessionId, settledByOp)
    .flatMap((row) => toStoredRow(row) ?? [])
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
    hold_reason: string | null
    returned_reason: string | null
    returned_rejection: string | null
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
    holdReason: record.hold_reason,
    returnedReason: record.returned_reason,
    returnedRejection: storedRejection(record.returned_rejection),
    settledAt: record.settled_at,
    settledByOp: record.settled_by_op,
    consumedAs: record.consumed_as
  }
}

function storedRejection(json: string | null): UnreadAgentSessionFailureFact | null {
  if (json === null) {
    return null
  }
  try {
    return readStoredRejectionFact(JSON.parse(json)) ?? null
  } catch {
    // The refusal stays readable from `returned_reason`; a bad fact must not lose the card.
    return null
  }
}
