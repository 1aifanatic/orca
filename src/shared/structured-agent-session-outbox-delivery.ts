// Whether an outbox entry asks the host to hold it as a draft (`delivery: 'queue-if-active'`).

import type { StructuredAgentSessionOutboxEntry } from './structured-agent-session-outbox'

/** What the connected host offers: `capable` when it advertises queued messages, `enabled` when
 *  the user's setting also wants them. */
export type StructuredAgentSessionQueueDelivery = { capable: boolean; enabled: boolean }

/**
 * The entry as its next attempt sends it. `delivery` is part of the operation, so an id already
 * attempted keeps it for fingerprint parity, and an id never attempted (new, or rotated after a
 * refusal) takes the current choice; text-only, and never on a launch prompt. A host without the
 * capability rejects the field before its operation ledger, so no attempt to it carries one,
 * whatever the id: keeping it there only makes every Retry fail the same way.
 */
export function decideStructuredAgentSessionEntryDelivery(
  entry: StructuredAgentSessionOutboxEntry,
  host: StructuredAgentSessionQueueDelivery
): StructuredAgentSessionOutboxEntry {
  const queued = entry.delivery === 'queue-if-active'
  const queue =
    entry.lastAttemptAt !== null || entry.source === 'launch'
      ? queued && host.capable
      : host.capable && host.enabled && entry.body.blocks.every((block) => block.type === 'text')
  if (queue === queued) {
    return entry
  }
  const { delivery: _decided, ...rest } = entry
  return queue ? { ...rest, delivery: 'queue-if-active' } : rest
}
