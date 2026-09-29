// Whether an outbox entry asks the host to hold it as a draft (`delivery: 'queue-if-active'`).
//
// Two facts, kept apart: `delivery` is the user's intent, and `sentDelivery` is what the first
// attempt put on the wire. An attempted id replays what it sent, for fingerprint parity with what
// the host may have recorded; nothing the capability says is written back over either. Nothing
// here ever holds a send: an unknown capability sends plain, as a host without queueing always has.

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

/** What an attempted entry sent. One attempted before `sentDelivery` was recorded sent its intent. */
export function structuredAgentSessionSentDelivery(
  entry: StructuredAgentSessionOutboxEntry
): 'queue-if-active' | null {
  return entry.sentDelivery !== undefined ? entry.sentDelivery : (entry.delivery ?? null)
}

/** Whether this entry's next request asks to be queued. An attempted id asks exactly what it sent,
 *  except of a host known not to queue, which rejects the field before its operation ledger, so
 *  nothing there was recorded with it. A first attempt asks only of a host known to queue, with
 *  the setting on, for plain text that is not a launch prompt. */
export function structuredAgentSessionEntryAsksToQueue(
  entry: StructuredAgentSessionOutboxEntry,
  host: StructuredAgentSessionQueueDelivery
): boolean {
  if (entry.lastAttemptAt !== null) {
    return (
      structuredAgentSessionSentDelivery(entry) === 'queue-if-active' &&
      host.capability !== 'unsupported'
    )
  }
  return (
    host.capability === 'supported' &&
    host.enabled &&
    entry.source !== 'launch' &&
    entry.body.blocks.every((block) => block.type === 'text')
  )
}

/** The user's intent at enqueue: what a first attempt would ask right now. */
export function structuredAgentSessionEntryDeliveryIntent(
  entry: StructuredAgentSessionOutboxEntry,
  host: StructuredAgentSessionQueueDelivery
): StructuredAgentSessionOutboxEntry {
  return withDelivery(entry, structuredAgentSessionEntryAsksToQueue(entry, host))
}

/**
 * The next attempt: `wire` is what the request sends, `stored` what the entry keeps. A first
 * attempt records what it sent; the setting off also drops the intent, which is plain and valid on
 * any host. The capability never rewrites the intent or what was sent.
 */
export function structuredAgentSessionEntryAttempt(
  entry: StructuredAgentSessionOutboxEntry,
  host: StructuredAgentSessionQueueDelivery
): { stored: StructuredAgentSessionOutboxEntry; wire: StructuredAgentSessionOutboxEntry } {
  const queue = structuredAgentSessionEntryAsksToQueue(entry, host)
  const stored: StructuredAgentSessionOutboxEntry =
    entry.lastAttemptAt !== null
      ? entry
      : {
          ...withDelivery(entry, host.enabled && (queue || entry.delivery === 'queue-if-active')),
          sentDelivery: queue ? 'queue-if-active' : null
        }
  return { stored, wire: withDelivery(stored, queue) }
}

/** The queue fields a stored entry carries, read back from storage. */
export function parseStructuredAgentSessionOutboxQueueFields(entry: {
  delivery?: unknown
  sentDelivery?: unknown
  outlivedStop?: unknown
}): Pick<StructuredAgentSessionOutboxEntry, 'delivery' | 'sentDelivery' | 'outlivedStop'> {
  return {
    ...(entry.delivery === 'queue-if-active' ? { delivery: 'queue-if-active' as const } : {}),
    ...(entry.sentDelivery === 'queue-if-active' || entry.sentDelivery === null
      ? { sentDelivery: entry.sentDelivery }
      : {}),
    ...(entry.outlivedStop === true ? { outlivedStop: true as const } : {})
  }
}
