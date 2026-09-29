// Whether an outbox entry asks the host to hold it as a draft (`delivery: 'queue-if-active'`).
//
// The entry stores the user's intent; what goes on the wire is decided per request. An attempted
// id replays exactly its first attempt's fields for fingerprint parity, so nothing the capability
// says is ever written back onto the entry: a strip stored during an unanswered probe would outlive
// it, and the host's ledger would refuse every later replay of that id.

import type { StructuredAgentSessionOutboxEntry } from './structured-agent-session-outbox'

/** What the connected host says about queued messages; `unknown` until it has answered, and after
 *  a failed probe. */
export type StructuredAgentSessionQueueCapability = 'unknown' | 'supported' | 'unsupported'

/** `enabled` is the user's setting. */
export type StructuredAgentSessionQueueDelivery = {
  capability: StructuredAgentSessionQueueCapability
  enabled: boolean
}

function withDelivery(
  entry: StructuredAgentSessionOutboxEntry,
  queue: boolean
): StructuredAgentSessionOutboxEntry {
  if (queue === (entry.delivery === 'queue-if-active')) {
    return entry
  }
  const { delivery: _decided, ...rest } = entry
  return queue ? { ...rest, delivery: 'queue-if-active' } : rest
}

/**
 * The intent an entry is stored with. Decided at enqueue, and again for an id never attempted
 * (new, or rotated after a refusal): that is the first attempt's choice. Only a host known to queue
 * decides it, text-only and never for a launch prompt; otherwise the intent stays as it is.
 */
export function structuredAgentSessionEntryDeliveryIntent(
  entry: StructuredAgentSessionOutboxEntry,
  host: StructuredAgentSessionQueueDelivery
): StructuredAgentSessionOutboxEntry {
  if (
    entry.lastAttemptAt !== null ||
    entry.source === 'launch' ||
    host.capability !== 'supported'
  ) {
    return entry
  }
  return withDelivery(
    entry,
    host.enabled && entry.body.blocks.every((block) => block.type === 'text')
  )
}

/**
 * The entry as this request sends it, or null while it must wait: one that asks to be queued waits
 * for the host to answer the capability probe. A host known not to queue rejects the field before
 * its operation ledger, so no request to it carries one, whatever the id.
 */
export function structuredAgentSessionEntryOnWire(
  entry: StructuredAgentSessionOutboxEntry,
  capability: StructuredAgentSessionQueueCapability
): StructuredAgentSessionOutboxEntry | null {
  if (entry.delivery !== 'queue-if-active' || capability === 'supported') {
    return entry
  }
  return capability === 'unknown' ? null : withDelivery(entry, false)
}
