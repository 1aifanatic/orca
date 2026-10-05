// Which per-emit fields ride one subscriber frame: the provider command catalog
// and the queue publication (the draft list with the queue's pause). Both are
// identity-deduplicated against the LAST VALUE SENT — never advanced on a frame
// that withheld the field, or the final replacement would be suppressed — and
// both attach whole to hydrating frames.

import type {
  AgentSessionSlashCommand,
  AgentSessionSubscribeEvent
} from '../../../shared/agent-session-wire'
import type { QueuePublication } from './structured-agent-session-queued-publication'
import type { NativeChatAsyncQuestionsField } from '../../../shared/native-chat-async-questions'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'

export type SubscriberFieldState = {
  sessionId: string
  commands?: AgentSessionSlashCommand[] | null
  /** The last queue publication actually SENT. */
  queuePublication?: QueuePublication
  /** The last pending async-question set actually SENT. */
  asyncQuestions?: NativeChatAsyncQuestionsField
}

export type SubscriberFieldHooks = {
  readCommands?: (sessionId: string) => AgentSessionSlashCommand[] | undefined
  readQueuePublication?: (sessionId: string) => QueuePublication | undefined
  /** Host-derived from the whole journal, so it never depends on the page a client holds. */
  readAsyncQuestions?: (journal: AgentSessionJournal) => NativeChatAsyncQuestionsField
}

export type SubscriberFrame = {
  frame: AgentSessionSubscribeEvent
  commands: AgentSessionSlashCommand[] | null
  attachedQueued: boolean
  queued: QueuePublication | undefined
  /** Set when this frame carries the async-question set. */
  asyncQuestions: NativeChatAsyncQuestionsField | undefined
}

/** Builds the frame to emit; the caller stores the returned refs only after the
 *  emit succeeded, so a dropped subscriber never advances its dedup state. */
export function buildSubscriberFrame(
  hooks: SubscriberFieldHooks,
  subscriber: SubscriberFieldState,
  event: AgentSessionSubscribeEvent,
  withholdQueued: boolean,
  journal?: AgentSessionJournal
): SubscriberFrame {
  const commands = hooks.readCommands?.(subscriber.sessionId) ?? null
  const includeCommands =
    hooks.readCommands !== undefined &&
    event.type !== 'end' &&
    (event.type !== 'batch' || commands !== subscriber.commands)
  // Withheld on intermediate catch-up pages (the caller says so), attached to
  // every hydrating frame, and to batches only when the list changed.
  const queued = withholdQueued ? undefined : hooks.readQueuePublication?.(subscriber.sessionId)
  const attachedQueued =
    queued !== undefined &&
    event.type !== 'end' &&
    (event.type !== 'batch' || queued !== subscriber.queuePublication)
  // Rides with the queue publication: whole on hydration, on batches only when it changed.
  const asyncQuestions =
    withholdQueued || !journal || event.type === 'end'
      ? undefined
      : hooks.readAsyncQuestions?.(journal)
  const attachedAsync =
    asyncQuestions !== undefined &&
    (event.type !== 'batch' || asyncQuestions !== subscriber.asyncQuestions)
  return {
    frame: {
      ...event,
      ...(includeCommands ? { commands: commands ?? null } : {}),
      ...(attachedQueued && queued
        ? { queuedMessages: queued.queuedMessages, queuePause: queued.queuePause }
        : {}),
      ...(attachedAsync ? { asyncQuestions } : {})
    },
    commands,
    attachedQueued,
    queued,
    asyncQuestions: attachedAsync ? asyncQuestions : undefined
  }
}

/** Whether a caught-up publish with no rows still owes this subscriber a frame:
 *  draft inserts and pause changes write no journal row, so an unchanged cursor
 *  must still deliver the changed publication. */
export function subscriberQueuedMessagesChanged(
  hooks: SubscriberFieldHooks,
  subscriber: SubscriberFieldState
): boolean {
  return (
    hooks.readQueuePublication !== undefined &&
    hooks.readQueuePublication(subscriber.sessionId) !== subscriber.queuePublication
  )
}
