// Restore for host-withdrawn drafts (Stop, Edit, /clear).
//
// The operation identity is persisted BEFORE the mutating RPC goes out and is
// dropped once the answer settles. A marker that outlives its window (a crash)
// is only released on remount, never replayed: the client has no way to ask for
// an operation's outcome without running it. Restoration is idempotent per
// (operation, message) for the life of this renderer — the same lifetime as the
// composer draft cache it writes to — so a replayed answer appends nothing twice.

import { AGENT_SESSION_MAX_NEW_OPERATION_AGE_MS } from '../../../../shared/agent-session-host-authority'
import type { AgentSessionWithdrawnQueuedMessage } from '../../../../shared/agent-session-wire'
import { appendNativeChatDraftCache } from './native-chat-draft-cache'
import { queuedMessageCardText } from './structured-agent-session-queued-cards'
import type {
  StructuredAgentSessionWrite,
  StructuredAgentSessionWriteOutcome
} from './use-structured-agent-session-mutate'

export type PendingQueuedWithdrawal = {
  operationId: string
  kind: 'stop' | 'edit' | 'clear'
  /** Only an Edit names one draft; Stop and clear withdraw the whole frontier. */
  messageId?: string
  beganAt: number
}

const STORAGE_PREFIX = 'orca:structuredAgentSessionQueuedRestore:v1:'
const MAX_RESTORED_OPERATIONS = 32

/** `${sessionId}\0${operationId}` → message ids already appended; insertion-ordered for eviction. */
const restoredByOperation = new Map<string, Set<string>>()

function storageKey(sessionId: string): string {
  return `${STORAGE_PREFIX}${encodeURIComponent(sessionId)}`
}

function isPendingQueuedWithdrawal(value: unknown): value is PendingQueuedWithdrawal {
  return (
    typeof value === 'object' &&
    value !== null &&
    'operationId' in value &&
    typeof value.operationId === 'string' &&
    'beganAt' in value &&
    typeof value.beganAt === 'number'
  )
}

// Bookkeeping never gates a user action: a torn or unreadable record reads as empty.
function readPending(sessionId: string): PendingQueuedWithdrawal[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(storageKey(sessionId)) ?? 'null')
    return Array.isArray(value) ? value.filter(isPendingQueuedWithdrawal) : []
  } catch {
    return []
  }
}

function writePending(sessionId: string, pending: readonly PendingQueuedWithdrawal[]): boolean {
  try {
    if (pending.length === 0) {
      localStorage.removeItem(storageKey(sessionId))
    } else {
      localStorage.setItem(storageKey(sessionId), JSON.stringify(pending))
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
  const current = readPending(sessionId)
  if (current.some((entry) => entry.operationId === pending.operationId)) {
    return true
  }
  return writePending(sessionId, [...current, pending])
}

/** Drop a marker whose operation settled with nothing to restore. */
export function abandonQueuedWithdrawal(sessionId: string, operationId: string): void {
  const current = readPending(sessionId)
  const next = current.filter((entry) => entry.operationId !== operationId)
  if (next.length !== current.length) {
    writePending(sessionId, next)
  }
}

/** Markers still recorded, oldest first; expired ones (past the host's
 *  operation-replay window) are dropped on read. */
export function pendingQueuedWithdrawals(
  sessionId: string,
  now: number = Date.now()
): PendingQueuedWithdrawal[] {
  const current = readPending(sessionId)
  const live = current.filter(
    (entry) => now - entry.beganAt <= AGENT_SESSION_MAX_NEW_OPERATION_AGE_MS
  )
  if (live.length !== current.length) {
    writePending(sessionId, live)
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
  const key = `${sessionId}\0${operationId}`
  const already = new Set([
    ...(restoredByOperation.get(key) ?? []),
    ...(options.alreadyRestored ?? [])
  ])
  const toRestore = withdrawn.filter((message) => !already.has(message.messageId))
  if (composerScopeKey) {
    for (const message of toRestore) {
      appendNativeChatDraftCache(composerScopeKey, queuedMessageCardText(message.body))
    }
  }
  for (const message of toRestore) {
    already.add(message.messageId)
  }
  restoredByOperation.delete(key)
  restoredByOperation.set(key, already)
  while (restoredByOperation.size > MAX_RESTORED_OPERATIONS) {
    const oldest = restoredByOperation.keys().next().value
    if (oldest === undefined) {
      break
    }
    restoredByOperation.delete(oldest)
  }
  abandonQueuedWithdrawal(sessionId, operationId)
}

const WITHDRAWAL_REPLAY_DELAYS_MS = [1_000, 2_000, 4_000]

/**
 * A withdrawal whose answer was lost (the call threw) is replayed under the SAME
 * operation id: the host answers one it already applied from the drafts' tombstones,
 * so the text still comes back even though the card has gone. In-session and
 * bounded; a refusal or a fence move is final.
 */
export async function writeQueuedWithdrawal<T>(
  write: StructuredAgentSessionWrite,
  method: string,
  fields: Record<string, unknown>,
  operationId: string
): Promise<StructuredAgentSessionWriteOutcome<T>> {
  let outcome = await write<T>(method, method, fields, operationId)
  for (const delayMs of WITHDRAWAL_REPLAY_DELAYS_MS) {
    if (outcome.kind !== 'not-done' || !outcome.answerLost) {
      break
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs))
    outcome = await write<T>(method, method, fields, operationId)
  }
  return outcome
}

export function clearQueuedWithdrawalsForTests(): void {
  restoredByOperation.clear()
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
