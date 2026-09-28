// Write-ahead restore for host-withdrawn drafts (Stop, Edit, /clear).
//
// The operation identity is persisted BEFORE the mutating RPC goes out, and the
// marker is removed only after the withdrawn text has durably reached the
// composer draft cache — so a crash between the host's withdrawal and the local
// restore keeps a replay handle instead of losing the text. Restoration is
// idempotent per (operation, message): a replayed answer restores nothing twice.

import { AGENT_SESSION_MAX_NEW_OPERATION_AGE_MS } from '../../../../shared/agent-session-host-authority'
import type { AgentSessionWithdrawnQueuedMessage } from '../../../../shared/agent-session-wire'
import { appendNativeChatDraftCache } from './native-chat-draft-cache'
import { queuedMessageCardText } from './structured-agent-session-queued-cards'

export type PendingQueuedWithdrawal = {
  operationId: string
  kind: 'stop' | 'edit' | 'clear'
  /** Only an Edit names one draft; Stop and clear withdraw the whole frontier. */
  messageId?: string
  beganAt: number
}

type QueuedRestoreRecord = {
  pending: PendingQueuedWithdrawal[]
  /** Recently completed operations with the message ids already restored, so a
   *  replayed or duplicated answer appends nothing twice. Bounded. */
  restored: { operationId: string; messageIds: string[] }[]
}

const STORAGE_PREFIX = 'orca:structuredAgentSessionQueuedRestore:v1:'
const MAX_COMPLETED_OPERATIONS = 8

function storageKey(sessionId: string): string {
  return `${STORAGE_PREFIX}${encodeURIComponent(sessionId)}`
}

function isQueuedRestoreRecord(value: unknown): value is QueuedRestoreRecord {
  return (
    typeof value === 'object' &&
    value !== null &&
    'pending' in value &&
    Array.isArray(value.pending) &&
    'restored' in value &&
    Array.isArray(value.restored)
  )
}

function readRecord(sessionId: string): QueuedRestoreRecord {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(storageKey(sessionId)) ?? 'null')
    if (isQueuedRestoreRecord(value)) {
      return value
    }
  } catch {
    // A torn record restores nothing stale; new operations start clean.
  }
  return { pending: [], restored: [] }
}

function writeRecord(sessionId: string, record: QueuedRestoreRecord): boolean {
  try {
    if (record.pending.length === 0 && record.restored.length === 0) {
      localStorage.removeItem(storageKey(sessionId))
    } else {
      localStorage.setItem(storageKey(sessionId), JSON.stringify(record))
    }
    return true
  } catch {
    return false
  }
}

/** Persist the operation identity before its RPC; a marker that cannot be
 *  written must not gate the user's action, so failures are reported as false
 *  and the caller proceeds. */
export function beginQueuedWithdrawal(
  sessionId: string,
  pending: PendingQueuedWithdrawal
): boolean {
  const record = readRecord(sessionId)
  if (record.pending.some((entry) => entry.operationId === pending.operationId)) {
    return true
  }
  return writeRecord(sessionId, { ...record, pending: [...record.pending, pending] })
}

/** Drop a marker whose operation settled with nothing to restore (refused, or
 *  the draft was already gone). */
export function abandonQueuedWithdrawal(sessionId: string, operationId: string): void {
  const record = readRecord(sessionId)
  writeRecord(sessionId, {
    ...record,
    pending: record.pending.filter((entry) => entry.operationId !== operationId)
  })
}

/** Markers still owed an answer, oldest first; expired ones (past the host's
 *  operation-replay window) are released rather than retried forever. */
export function pendingQueuedWithdrawals(
  sessionId: string,
  now: number = Date.now()
): PendingQueuedWithdrawal[] {
  const record = readRecord(sessionId)
  const live = record.pending.filter(
    (entry) => now - entry.beganAt <= AGENT_SESSION_MAX_NEW_OPERATION_AGE_MS
  )
  if (live.length !== record.pending.length) {
    writeRecord(sessionId, { ...record, pending: live })
  }
  return live
}

/**
 * Append the withdrawn bodies to the composer draft (each body separately —
 * they were separate drafts), skipping any this operation already restored,
 * then retire the marker. Newer typing is preserved: the cache appends after
 * whatever is currently there.
 */
export function completeQueuedWithdrawal(
  sessionId: string,
  operationId: string,
  withdrawn: readonly AgentSessionWithdrawnQueuedMessage[],
  composerScopeKey: string | undefined,
  options: {
    /** Ids another mechanism (the sender's own outbox withdrawal) already put back;
     *  recorded as restored so a replay stays a no-op, but never appended again. */
    alreadyRestored?: readonly string[]
  } = {}
): void {
  const record = readRecord(sessionId)
  const already = new Set([
    ...(record.restored.find((entry) => entry.operationId === operationId)?.messageIds ?? []),
    ...(options.alreadyRestored ?? [])
  ])
  const toRestore = withdrawn.filter((message) => !already.has(message.messageId))
  if (composerScopeKey) {
    for (const message of toRestore) {
      appendNativeChatDraftCache(composerScopeKey, queuedMessageCardText(message.body))
    }
  }
  const restored = [
    ...record.restored.filter((entry) => entry.operationId !== operationId),
    { operationId, messageIds: [...already, ...toRestore.map((message) => message.messageId)] }
  ].slice(-MAX_COMPLETED_OPERATIONS)
  writeRecord(sessionId, {
    pending: record.pending.filter((entry) => entry.operationId !== operationId),
    restored
  })
}

export function clearQueuedWithdrawalsForTests(): void {
  try {
    for (let index = localStorage.length - 1; index >= 0; index -= 1) {
      const key = localStorage.key(index)
      if (key?.startsWith(STORAGE_PREFIX)) {
        localStorage.removeItem(key)
      }
    }
  } catch {
    // Test-only cleanup.
  }
}
