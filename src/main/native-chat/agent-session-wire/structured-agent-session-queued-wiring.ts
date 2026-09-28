// Host wiring for mid-turn queueing: builds the serialized drain from the
// host's own collaborators and exposes the two draft mutations, so the host
// class stays a description of its surface.

import type { StructuredAgentSessionMutationContext } from './structured-agent-session-host-mutations'
import type {
  StructuredAgentSessionCaller,
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession
} from './structured-agent-session-host-types'
import { structuredAgentSessionConversationFence } from './structured-agent-session-provider-child'
import { StructuredAgentSessionQueuedMessageDrain } from './structured-agent-session-queued-messages'
import { releaseQueuePauseOnUserTurnStart } from './structured-agent-session-queued-stop'
import {
  deleteQueuedStructuredAgentMessage,
  sendQueuedStructuredAgentMessage
} from './structured-agent-session-queued-mutations'

export function wireStructuredAgentSessionQueuedMessages(host: {
  sessions: ReadonlyMap<string, StructuredAgentSessionHostSession>
  /** Lazy: the host's `deps` parameter property is not yet assigned while its fields initialize. */
  deps: () => StructuredAgentSessionHostDeps
  serialize: <T>(sessionId: string, task: () => Promise<T>) => Promise<T>
  flushStreamedEvents: (sessionId: string) => Promise<void>
  wakeDelivery: (sessionId: string) => void
  /** The idle sweep's activity renewal, which the drain's schedule rides. */
  touch: (sessionId: string) => void
  mutationContext: () => StructuredAgentSessionMutationContext
}) {
  const drain = new StructuredAgentSessionQueuedMessageDrain({
    sessions: host.sessions,
    getRecord: (sessionId) => host.deps().store.getRecord(sessionId),
    serialize: host.serialize,
    flushStreamedEvents: host.flushStreamedEvents,
    conversationFence: (sessionId) =>
      structuredAgentSessionConversationFence(host.deps().store, sessionId),
    wakeDelivery: host.wakeDelivery,
    onError: (sessionId, error) => host.deps().onEventSinkError?.({ sessionId, error })
  })
  return {
    drain,
    /** Every journal publish: turn, submission, prompt, command and Stop
     *  settlements are all commits, and each re-derives the drain's gates —
     *  and whether a user send's turn has started, lifting the Stop pause. */
    onJournalActivity: (sessionId: string) => {
      host.touch(sessionId)
      releaseQueuePauseOnUserTurnStart(sessionId, host.sessions.get(sessionId))
      drain.schedule(sessionId)
    },
    queuedMessageSend: (
      caller: StructuredAgentSessionCaller,
      params: Parameters<typeof sendQueuedStructuredAgentMessage>[2]
    ) => sendQueuedStructuredAgentMessage(host.mutationContext(), caller, params),
    queuedMessageDelete: (
      caller: StructuredAgentSessionCaller,
      params: Parameters<typeof deleteQueuedStructuredAgentMessage>[2]
    ) => deleteQueuedStructuredAgentMessage(host.mutationContext(), caller, params)
  }
}
