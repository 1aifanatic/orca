// Host wiring for mid-turn queueing: builds the serialized drain from the
// host's mutation context and exposes the draft actions (Send, Delete, Resume), so the host
// class stays a description of its surface.

import type { StructuredAgentSessionMutationContext } from './structured-agent-session-host-mutations'
import type {
  StructuredAgentSessionCaller,
  StructuredAgentSessionHostSession
} from './structured-agent-session-host-types'
import { structuredAgentSessionConversationFence } from './structured-agent-session-provider-child'
import { StructuredAgentSessionQueuedMessageDrain } from './structured-agent-session-queued-messages'
import { adoptEndedRestartPause } from './structured-agent-session-queued-pause'
import {
  deleteQueuedStructuredAgentMessage,
  resumeStructuredAgentQueue,
  sendQueuedStructuredAgentMessage
} from './structured-agent-session-queued-mutations'
import { deferredStructuredAgentSessionLogger } from './structured-agent-session-logger'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'

/** The agents' cards each journal last held waiting, read again only when its queue changed. */
const waitingAgentCards = new WeakMap<AgentSessionJournal, { revision: number; ids: Set<string> }>()

/** Whether an agent's card stopped waiting (sent, returned, deleted or carried) since last read. */
function agentCardSettled(journal: AgentSessionJournal): boolean {
  const revision = journal.queuedMessages.revision()
  const seen = waitingAgentCards.get(journal)
  if (seen?.revision === revision) {
    return false
  }
  const ids = new Set(
    journal.queuedMessages
      .list()
      .filter((row) => row.state === 'waiting' && row.source.kind === 'agent')
      .map((row) => row.messageId)
  )
  waitingAgentCards.set(journal, { revision, ids })
  return [...(seen?.ids ?? [])].some((id) => !ids.has(id))
}

/** `sessions` are the live conversations (their `touch` is the idle sweep's activity renewal,
 *  which the drain's schedule rides); everything else comes from the host's mutation context,
 *  read lazily because the host's fields are still initializing when this is built. */
export function wireStructuredAgentSessionQueuedMessages(
  sessions: ReadonlyMap<string, StructuredAgentSessionHostSession> & {
    touch: (sessionId: string) => void
  },
  context: () => StructuredAgentSessionMutationContext
) {
  const drain = new StructuredAgentSessionQueuedMessageDrain({
    sessions,
    getRecord: (sessionId) => context().deps.store.getRecord(sessionId),
    serialize: (sessionId, task) => context().serialize(sessionId, task),
    conversationFence: (sessionId) =>
      structuredAgentSessionConversationFence(context().deps.store, sessionId),
    wakeDelivery: (sessionId) => context().wakeDelivery(sessionId),
    // Read lazily, like the rest of this wiring: the host's deps are not assigned yet.
    logger: deferredStructuredAgentSessionLogger(() => context().deps.logger)
  })
  return {
    drain,
    /** Every journal publish: turn, submission, prompt, command and Stop
     *  settlements are all commits, and each re-derives the drain's gates —
     *  and adopts a restart's cards once a person's turn started. */
    onJournalActivity: (sessionId: string) => {
      sessions.touch(sessionId)
      const journal = sessions.get(sessionId)?.journal
      if (journal && !journal.isReadOnly) {
        void adoptEndedRestartPause(sessionId, journal, context().deps.logger)
      }
      if (journal && agentCardSettled(journal)) {
        context().deps.onAgentCardSettled?.(sessionId)
      }
      drain.schedule(sessionId)
    },
    queuedMessageSend: (
      caller: StructuredAgentSessionCaller,
      params: Parameters<typeof sendQueuedStructuredAgentMessage>[2]
    ) => sendQueuedStructuredAgentMessage(context(), caller, params),
    queuedMessageDelete: (
      caller: StructuredAgentSessionCaller,
      params: Parameters<typeof deleteQueuedStructuredAgentMessage>[2]
    ) => deleteQueuedStructuredAgentMessage(context(), caller, params),
    queuedMessagesResume: (
      caller: StructuredAgentSessionCaller,
      params: Parameters<typeof resumeStructuredAgentQueue>[2]
    ) => resumeStructuredAgentQueue(context(), caller, params)
  }
}
