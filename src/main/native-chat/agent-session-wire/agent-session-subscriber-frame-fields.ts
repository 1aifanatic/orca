// Which per-emit fields ride one subscriber frame: the provider command catalog
// and the queued-draft list. Both are identity-deduplicated against the LAST
// VALUE SENT — never advanced on a frame that withheld the field, or the final
// replacement would be suppressed — and both attach whole to hydrating frames.

import type {
  AgentSessionQueuedMessage,
  AgentSessionSlashCommand,
  AgentSessionSubscribeEvent
} from '../../../shared/agent-session-wire'

export type SubscriberFieldState = {
  sessionId: string
  commands?: AgentSessionSlashCommand[] | null
  /** The last draft list actually SENT. */
  queuedMessages?: AgentSessionQueuedMessage[]
}

export type SubscriberFieldHooks = {
  readCommands?: (sessionId: string) => AgentSessionSlashCommand[] | undefined
  readQueuedMessages?: (sessionId: string) => AgentSessionQueuedMessage[] | undefined
}

export type SubscriberFrame = {
  frame: AgentSessionSubscribeEvent
  commands: AgentSessionSlashCommand[] | null
  attachedQueued: boolean
  queued: AgentSessionQueuedMessage[] | undefined
}

/** Builds the frame to emit; the caller stores the returned refs only after the
 *  emit succeeded, so a dropped subscriber never advances its dedup state. */
export function buildSubscriberFrame(
  hooks: SubscriberFieldHooks,
  subscriber: SubscriberFieldState,
  event: AgentSessionSubscribeEvent,
  withholdQueued: boolean
): SubscriberFrame {
  const commands = hooks.readCommands?.(subscriber.sessionId) ?? null
  const includeCommands =
    hooks.readCommands !== undefined &&
    event.type !== 'end' &&
    (event.type !== 'batch' || commands !== subscriber.commands)
  // Withheld on intermediate catch-up pages (the caller says so), attached to
  // every hydrating frame, and to batches only when the list changed.
  const queued = withholdQueued ? undefined : hooks.readQueuedMessages?.(subscriber.sessionId)
  const attachedQueued =
    queued !== undefined &&
    event.type !== 'end' &&
    (event.type !== 'batch' || queued !== subscriber.queuedMessages)
  return {
    frame: {
      ...event,
      ...(includeCommands ? { commands: commands ?? null } : {}),
      ...(attachedQueued ? { queuedMessages: queued } : {})
    },
    commands,
    attachedQueued,
    queued
  }
}

/** Whether a caught-up publish with no rows still owes this subscriber a frame:
 *  draft inserts and pauses write no journal row, so an unchanged cursor must
 *  still deliver the changed list. */
export function subscriberQueuedMessagesChanged(
  hooks: SubscriberFieldHooks,
  subscriber: SubscriberFieldState
): boolean {
  return (
    hooks.readQueuedMessages !== undefined &&
    hooks.readQueuedMessages(subscriber.sessionId) !== subscriber.queuedMessages
  )
}
