import type Database from '../../sqlite/sync-database'
import { journalPragmaNumber } from './journal-database'
import { JOURNAL_DB_SCHEMA_VERSION } from './journal-database-schema'
import { assertJournalWritable } from './journal-write-guards'
import {
  commandReceiptSchema,
  commandReceiptScopeKey,
  type CommandReceipt,
  type CommandReceiptScope
} from './command-receipt-schema'

export type CommandReceiptRead =
  | { verdict: 'absent' }
  | { verdict: 'readable'; receipt: CommandReceipt }
  | { verdict: 'unreadable'; scope: CommandReceiptScope; operationId: string }

export type ExistingCommandReceipt = Exclude<CommandReceiptRead, { verdict: 'absent' }>

export type CommandReceiptInsert =
  | { inserted: true }
  | {
      inserted: false
      reason: 'duplicate' | 'conflict'
      existing: Extract<CommandReceiptRead, { verdict: 'readable' }>
    }
  | {
      inserted: false
      reason: 'unreadable'
      existing: Extract<CommandReceiptRead, { verdict: 'unreadable' }>
    }

const SELECT_RECEIPT = `SELECT session_id, caller_key, method, fingerprint, status,
  result_json, rejection_json, accepted_at FROM agent_session_command_receipts
  WHERE scope = ? AND operation_id = ?`

function parseReceiptJson(value: unknown): unknown {
  return typeof value === 'string' ? JSON.parse(value) : undefined
}

export function readCommandReceipt(
  db: Database.Database,
  scope: CommandReceiptScope,
  operationId: string
): CommandReceiptRead {
  const unreadable: CommandReceiptRead = { verdict: 'unreadable', scope, operationId }
  // A newer read-only database may not expose this table; that cannot authorize a retry.
  if (
    !db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get('agent_session_command_receipts')
  ) {
    return unreadable
  }
  const row = db.prepare(SELECT_RECEIPT).get(commandReceiptScopeKey(scope), operationId)
  if (!row) {
    return { verdict: 'absent' }
  }
  try {
    if (
      (row.status === 'accepted' && row.rejection_json !== null) ||
      (row.status === 'rejected' && row.result_json !== null)
    ) {
      return unreadable
    }
    const parsed = commandReceiptSchema.safeParse({
      scope,
      operationId,
      sessionId: row.session_id,
      callerKey: row.caller_key,
      method: row.method,
      fingerprint: row.fingerprint,
      status: row.status,
      acceptedAt: row.accepted_at,
      ...(row.status === 'accepted'
        ? { result: parseReceiptJson(row.result_json) }
        : { rejection: parseReceiptJson(row.rejection_json) })
    })
    return parsed.success ? { verdict: 'readable', receipt: parsed.data } : unreadable
  } catch {
    return unreadable
  }
}

/** The caller owns the effect's transaction; this function never reserves or commits on its own. */
export function insertCommandReceiptIfAbsent(
  db: Database.Database,
  receipt: CommandReceipt
): CommandReceiptInsert {
  assertJournalWritable(
    journalPragmaNumber(db, 'user_version') > JOURNAL_DB_SCHEMA_VERSION,
    receipt.sessionId
  )
  if (!db.isTransaction) {
    throw new Error('a command receipt must be written inside its effect transaction')
  }
  const written = commandReceiptSchema.parse(receipt)
  const inserted = db
    .prepare(`INSERT INTO agent_session_command_receipts
      (scope, operation_id, session_id, caller_key, method, fingerprint, status,
       result_json, rejection_json, accepted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(scope, operation_id) DO NOTHING`)
    .run(
      commandReceiptScopeKey(written.scope),
      written.operationId,
      written.sessionId,
      written.callerKey,
      written.method,
      written.fingerprint,
      written.status,
      written.status === 'accepted' ? JSON.stringify(written.result) : null,
      written.status === 'rejected' ? JSON.stringify(written.rejection) : null,
      written.acceptedAt
    )
  if (Number(inserted.changes) === 1) {
    return { inserted: true }
  }
  const existing = readCommandReceipt(db, written.scope, written.operationId)
  if (existing.verdict === 'absent') {
    throw new Error('an existing command receipt disappeared inside its transaction')
  }
  if (existing.verdict === 'unreadable') {
    return { inserted: false, reason: 'unreadable', existing }
  }
  return {
    inserted: false,
    existing,
    reason: existing.receipt.fingerprint === written.fingerprint ? 'duplicate' : 'conflict'
  }
}
