import type { OrchestrationDb } from '../orchestration-db'
import { z } from 'zod'
import { structuredPointerBatchFingerprint } from '../../structured-pointer-operation-id'

/** The live agent-session operation id backing one structured worker mailbox's pointer send. */
export type StructuredPointerOperationRow = {
  mailbox_handle: string
  session_id: string
  operation_id: string
  batch_fingerprint: string
  minted_at_ms: number
  /** Absent on legacy operations; never infer a changed batch from their count. */
  message_ids?: readonly string[]
}

const storedPointerOperation = z.object({
  mailbox_handle: z.string(),
  session_id: z.string(),
  operation_id: z.string(),
  batch_fingerprint: z.string(),
  minted_at_ms: z.number(),
  message_ids_json: z.string().nullable()
})

export function getStructuredPointerOperation(
  this: OrchestrationDb,
  mailboxHandle: string
): StructuredPointerOperationRow | undefined {
  const stored = this.db
    .prepare('SELECT * FROM structured_pointer_operations WHERE mailbox_handle = ?')
    .get(mailboxHandle)
  if (stored === undefined) {
    return undefined
  }
  const { message_ids_json, ...row } = storedPointerOperation.parse(stored)
  const messageIds =
    message_ids_json === null ? undefined : z.array(z.string()).parse(JSON.parse(message_ids_json))
  // A downgraded host can replace an operation without touching newer columns.
  const matchingBatch =
    messageIds &&
    structuredPointerBatchFingerprint(row.session_id, messageIds) === row.batch_fingerprint
  return {
    ...row,
    ...(matchingBatch ? { message_ids: messageIds } : {})
  }
}

export function putStructuredPointerOperation(
  this: OrchestrationDb,
  row: StructuredPointerOperationRow
): void {
  this.db
    .prepare(
      `INSERT INTO structured_pointer_operations
         (mailbox_handle, session_id, operation_id, batch_fingerprint, minted_at_ms, message_ids_json)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(mailbox_handle) DO UPDATE SET
         session_id = excluded.session_id, operation_id = excluded.operation_id,
         batch_fingerprint = excluded.batch_fingerprint, minted_at_ms = excluded.minted_at_ms,
         message_ids_json = excluded.message_ids_json`
    )
    .run(
      row.mailbox_handle,
      row.session_id,
      row.operation_id,
      row.batch_fingerprint,
      row.minted_at_ms,
      row.message_ids ? JSON.stringify(row.message_ids) : null
    )
}

export function deleteStructuredPointerOperation(
  this: OrchestrationDb,
  mailboxHandle: string
): void {
  this.db
    .prepare('DELETE FROM structured_pointer_operations WHERE mailbox_handle = ?')
    .run(mailboxHandle)
}

export type StructuredPointerOperationStoreMethods = {
  getStructuredPointerOperation: typeof getStructuredPointerOperation
  putStructuredPointerOperation: typeof putStructuredPointerOperation
  deleteStructuredPointerOperation: typeof deleteStructuredPointerOperation
}

export function attachStructuredPointerOperationStore(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    getStructuredPointerOperation,
    putStructuredPointerOperation,
    deleteStructuredPointerOperation
  })
}
