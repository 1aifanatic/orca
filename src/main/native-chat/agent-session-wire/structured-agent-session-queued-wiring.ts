// Host wiring for mid-turn queueing: builds the serialized drain from the
// host's mutation context — with the /clear runner its /clear cards use — and exposes the draft
// actions (Send, Delete, Resume), so the host class stays a description of its surface.

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
import {
  isUnsettledQueuedMessage,
  listQueuedMessages
} from '../agent-session-journal/queued-message-table'
import { runQueuedConversationClear } from './structured-conversation-clear'
import {
  carryQueuedMessagesToClearReplacement,
  committedClearOf
} from './structured-conversation-clear-carry'

/** `sessions` are the live conversations (their `touch` is the idle sweep's activity renewal,
 *  which the drain's schedule rides); everything else comes from the host's mutation context,
 *  read lazily because the host's fields are still initializing when this is built. */
export function wireStructuredAgentSessionQueuedMessages(
  sessions: ReadonlyMap<string, StructuredAgentSessionHostSession> & {
    touch: (sessionId: string) => void
  },
  context: () => StructuredAgentSessionMutationContext,
  /** What follows a committed /clear, outside the source's serialize. */
  afterClear: (sessionId: string) => Promise<void>
) {
  const clearContext = (sessionId: string, journal: AgentSessionJournal) => ({
    sessionId,
    journal,
    fence: structuredAgentSessionConversationFence(context().deps.store, sessionId),
    adapter: context().deps.adapter,
    logger: context().deps.logger
  })
  const drain = new StructuredAgentSessionQueuedMessageDrain({
    sessions,
    getRecord: (sessionId) => context().deps.store.getRecord(sessionId),
    serialize: (sessionId, task) => context().serialize(sessionId, task),
    conversationFence: (sessionId) =>
      structuredAgentSessionConversationFence(context().deps.store, sessionId),
    wakeDelivery: (sessionId) => context().wakeDelivery(sessionId),
    // Read lazily, like the rest of this wiring: the host's deps are not assigned yet.
    logger: deferredStructuredAgentSessionLogger(() => context().deps.logger),
    runQueuedClear: async (sessionId, card) =>
      (
        await runQueuedConversationClear(
          context(),
          clearContext(sessionId, sessions.get(sessionId)!.journal),
          card
        )
      ).kind === 'cleared',
    carryAfterClear: async (sessionId) => {
      const marker = committedClearOf(context().deps.store.getRecord(sessionId))
      const journal = sessions.get(sessionId)?.journal
      if (!marker || !journal) {
        return
      }
      await carryQueuedMessagesToClearReplacement(clearContext(sessionId, journal), {
        replacementSessionId: marker.replacementSessionId,
        openReplacementJournal: async () =>
          (await context().conversation(marker.replacementSessionId)).journal,
        callerKey: marker.callerKey,
        operationId: marker.operationId
      })
    },
    afterClear
  })
  /** A replacement opening is where its cards are looked for: a source whose carry a crash cut
   *  short is opened, and its drain finishes the carry. Read from the shared table, so a source
   *  with nothing owed is never opened. */
  const finishCarriesInto = (replacementSessionId: string): void => {
    const { store, journalDatabase } = context().deps
    for (const record of store.listRecords()) {
      const marker = committedClearOf(record)
      if (
        marker?.replacementSessionId !== replacementSessionId ||
        !listQueuedMessages(journalDatabase.db, record.sessionId).some(isUnsettledQueuedMessage)
      ) {
        continue
      }
      void context()
        .conversation(record.sessionId)
        .then(() => drain.schedule(record.sessionId))
        .catch((error: unknown) => {
          context().deps.logger.warn("finishing a /clear's carry failed", {
            scope: 'clear-queued-carry',
            sessionId: record.sessionId,
            error
          })
        })
    }
  }
  /** A card's Send that ran its /clear: the same follow-up as the drain's. */
  const clearedByCard = (sessionId: string, messageId: string): boolean =>
    committedClearOf(context().deps.store.getRecord(sessionId))?.operationId === messageId
  return {
    drain,
    /** A conversation opened: its drain re-derives, and any carry owed into it is finished. */
    onConversationOpened: (sessionId: string) => {
      drain.schedule(sessionId)
      try {
        finishCarriesInto(sessionId)
      } catch (error) {
        context().deps.logger.warn("finding a /clear's owed carry failed", {
          scope: 'clear-queued-carry',
          sessionId,
          error
        })
      }
    },
    /** Every journal publish: turn, submission, prompt, command and Stop
     *  settlements are all commits, and each re-derives the drain's gates —
     *  and adopts a restart's cards once a person's turn started. */
    onJournalActivity: (sessionId: string) => {
      sessions.touch(sessionId)
      const journal = sessions.get(sessionId)?.journal
      if (journal) {
        void adoptEndedRestartPause(sessionId, journal, context().deps.logger)
      }
      drain.schedule(sessionId)
    },
    queuedMessageSend: async (
      caller: StructuredAgentSessionCaller,
      params: Parameters<typeof sendQueuedStructuredAgentMessage>[2]
    ) => {
      const result = await sendQueuedStructuredAgentMessage(context(), caller, params)
      const { sessionId } = params.envelope
      if (result.ok && clearedByCard(sessionId, params.messageId)) {
        await afterClear(sessionId)
      }
      return result
    },
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
