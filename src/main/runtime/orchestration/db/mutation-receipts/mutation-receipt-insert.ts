import {
  ORCHESTRATION_RETRY_WINDOW_MS,
  orchestrationRetryRequestIssuedAtMs
} from '../../../../../shared/orchestration-retry-request-id'
import { OrchestrationError } from '../../orchestration-error'
import type { MutationReceiptRow } from '../../types'
import type { OrchestrationDb } from '../orchestration-db'

export type MutationReceiptInput = {
  callerFingerprint: string
  requestId: string
  method: string
  payloadHash: string
  receipt?: string
}

export type MutationReceiptInsert =
  | { inserted: true }
  | { inserted: false; reason: 'duplicate' | 'conflict'; existing: MutationReceiptRow }

export function insertMutationReceiptIfAbsent(
  store: OrchestrationDb,
  params: MutationReceiptInput
): MutationReceiptInsert {
  if (!store.db.isTransaction) {
    throw new Error('A mutation receipt must be written inside an open transaction')
  }
  const existing = store.getMutationReceipt(params.callerFingerprint, params.requestId)
  if (existing) {
    return {
      inserted: false,
      reason:
        existing.method === params.method && existing.payload_hash === params.payloadHash
          ? 'duplicate'
          : 'conflict',
      existing
    }
  }
  const issuedAtMs = orchestrationRetryRequestIssuedAtMs(params.requestId)
  if (issuedAtMs !== null) {
    const boundary = store.db
      .prepare('SELECT retired_before_ms FROM mutation_receipt_retirement WHERE singleton = 1')
      .get()?.retired_before_ms
    if (typeof boundary !== 'number' || !Number.isSafeInteger(boundary)) {
      throw new Error('Mutation receipt retirement boundary is missing or invalid')
    }
    if (issuedAtMs < Date.now() - ORCHESTRATION_RETRY_WINDOW_MS || issuedAtMs < boundary) {
      throw new OrchestrationError(
        'operation_unknown',
        `Request ${params.requestId} is older than Orca's 30-day retry window, so Orca can't tell whether it already ran. Check the work it would have created, or run the command again without --retry-request.`,
        { requestId: params.requestId }
      )
    }
  }
  store.db
    .prepare(`INSERT INTO mutation_receipts (
      caller_fingerprint, request_id, method, payload_hash, state, receipt, request_issued_at_ms
    ) VALUES (?, ?, ?, ?, 'pending', ?, ?)`)
    .run(
      params.callerFingerprint,
      params.requestId,
      params.method,
      params.payloadHash,
      params.receipt ?? null,
      issuedAtMs
    )
  return { inserted: true }
}
