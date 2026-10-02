// A launch prompt's outbox entry: its source (notes, review comments, a fix action) still holds it
// as unsent until the agent takes it, and is where it is sent again.

import type {
  StructuredAgentSessionAttemptFailure,
  StructuredAgentSessionOutboxEntry
} from './structured-agent-session-outbox'

/** Withdrawn by a Stop, it stays as not sent rather than going to the composer as a second copy. */
export function withdrawnFromItsSource(
  entry: StructuredAgentSessionOutboxEntry,
  lastFailure: StructuredAgentSessionAttemptFailure = {
    kind: 'rejected',
    reason: null,
    rejection: { kind: 'cancelled' }
  }
): StructuredAgentSessionOutboxEntry {
  return { ...entry, state: 'rejected', lastFailure }
}
