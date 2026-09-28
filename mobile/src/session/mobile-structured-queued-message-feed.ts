// The host publishes its queued drafts whole-list on the subscribe stream:
// present = the current list, absent = unchanged since the last frame this
// subscriber was sent, `null` = empty. History pages are ignored here — the
// live stream is authoritative and a stale history answer must never replace
// a newer live list.

import type {
  AgentSessionQueuedMessage,
  AgentSessionSubscribeEvent
} from '../../../src/shared/agent-session-wire'

/** Null = no claim yet (older host, or nothing published on this stream). */
export type MobileQueuedMessageFeed = AgentSessionQueuedMessage[] | null

export function reduceMobileQueuedMessageFeed(
  previous: MobileQueuedMessageFeed,
  event: AgentSessionSubscribeEvent
): MobileQueuedMessageFeed {
  if (event.type === 'end') {
    return previous
  }
  if (event.queuedMessages === undefined) {
    return previous
  }
  const list = event.queuedMessages ?? []
  if (list.length === 0 && previous !== null && previous.length === 0) {
    return previous
  }
  // Host order is authoritative; sort defensively so card order never depends
  // on publication order.
  return [...list].sort((left, right) => left.position - right.position)
}
