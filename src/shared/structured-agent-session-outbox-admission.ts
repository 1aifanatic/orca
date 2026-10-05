// Which outbox entry goes out next.

import {
  structuredAgentSessionEntryRejectedByHost,
  structuredAgentSessionEntryReturning,
  type StructuredAgentSessionOutboxEntry
} from './structured-agent-session-outbox'

/** Whether nothing but an answer already owed settles this entry, so it never goes out again: a
 *  send a Stop outran, or one an older build held for a Retry. */
export function structuredAgentSessionEntryAwaitsSettlement(
  entry: StructuredAgentSessionOutboxEntry
): boolean {
  return entry.stoppedBy !== undefined || entry.legacyUnsettled === true
}

export type StructuredAgentSessionOutboxAdmission =
  | { state: 'dispatch'; entry: StructuredAgentSessionOutboxEntry }
  | { state: 'blocked'; entry: StructuredAgentSessionOutboxEntry }
  | { state: 'idle'; entry: null }

/**
 * What the queue does next. The drain and the delivery notices both read it.
 *
 * A `dispatching` entry is not a barrier: the host appended its journal row inside the
 * per-session serialize chain before dispatching, so nothing behind it can overtake it. An
 * `unconfirmed` entry is, while it is sent again: sending past it would reorder around a message
 * that may yet land, and its resend settles it. One that never goes out again holds nothing up,
 * nor does one whose text is on its way back to the draft, or one the host recorded and rejected.
 */
export function admitStructuredAgentSessionOutboxEntry(
  entries: readonly StructuredAgentSessionOutboxEntry[]
): StructuredAgentSessionOutboxAdmission {
  for (const entry of entries) {
    if (
      structuredAgentSessionEntryAwaitsSettlement(entry) ||
      structuredAgentSessionEntryReturning(entry) ||
      structuredAgentSessionEntryRejectedByHost(entry)
    ) {
      continue
    }
    if (entry.state === 'unconfirmed') {
      return { state: 'blocked', entry }
    }
    if (entry.state === 'queued') {
      return { state: 'dispatch', entry }
    }
  }
  return { state: 'idle', entry: null }
}
