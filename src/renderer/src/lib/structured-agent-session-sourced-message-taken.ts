// When a message sent to a chat from somewhere else counts as delivered: once the agent has taken
// it. A launch's prompt, or review notes sent to a chat at rest, start its agent, and the host
// answers the send when it accepts the message, before that start; a source that writes outward on
// delivery (GitHub replies, cleared notes) must not do so for an agent that never started. So the
// wait follows the message to its own final state, read from the session's publication and the
// chat's outbox: no new wire field, and no timer of its own. A start the host retries keeps the
// message queued, and the retry schedule ends in a verdict.

import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import type { AgentSessionQueuedMessage } from '../../../shared/agent-session-queued-message-wire'
import type { StructuredAgentSessionOutboxEntry } from '../../../shared/structured-agent-session-outbox'
import { structuredAgentSessionEntryHeldForRetry } from '../../../shared/structured-agent-session-outbox-admission'
import { subscribeToStructuredAgentSessionOutboxCommits } from '@/components/native-chat/structured-agent-session-outbox-storage'
import { subscribeStructuredAgentSession } from '@/runtime/structured-agent-session-client'

type SourcedMessageVerdict = 'taken' | 'not-taken' | 'waiting'

export function structuredSourcedMessageVerdict(
  submission: Pick<AgentJournalSubmission, 'dispatchState'>
): SourcedMessageVerdict {
  switch (submission.dispatchState) {
    case 'accepted':
      return 'taken'
    // Unknown is a hand-over whose answer was lost, which a late echo can still prove taken.
    case 'pending':
    case 'unknown':
      return 'waiting'
    // A start that failed for good, or a chat closed first.
    case 'rejected':
      return 'not-taken'
  }
}

/** The outbox's word on the message: one it holds as not sent waits only for a Retry its source
 *  owns. Gone from the outbox, the journal has it. */
function outboxVerdict(
  entries: readonly StructuredAgentSessionOutboxEntry[],
  clientMessageId: string
): SourcedMessageVerdict {
  const entry = entries.find((candidate) => candidate.clientMessageId === clientMessageId)
  return entry && (entry.state === 'rejected' || structuredAgentSessionEntryHeldForRetry(entry))
    ? 'not-taken'
    : 'waiting'
}

// One read per message, whoever asks.
const inFlight = new Map<string, Promise<boolean>>()

/** Whether the chat's agent took the message: only accepted, held as a draft behind a running turn,
 *  or not sent answer it. Anything that ends the read first (the stream ending or failing) answers
 *  no: the source keeps what it would have written. */
export function awaitStructuredSourcedMessageTaken(
  sessionId: string,
  clientMessageId: string
): Promise<boolean> {
  const key = `${sessionId}:${clientMessageId}`
  const existing = inFlight.get(key)
  if (existing) {
    return existing
  }
  const read = readUntilFinal(sessionId, clientMessageId).finally(() => inFlight.delete(key))
  inFlight.set(key, read)
  return read
}

function readUntilFinal(sessionId: string, clientMessageId: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    let unsubscribe: (() => void) | null = null
    const finish = (taken: boolean): void => {
      if (settled) {
        return
      }
      settled = true
      stopOutbox()
      unsubscribe?.()
      resolve(taken)
    }
    const stopOutbox = subscribeToStructuredAgentSessionOutboxCommits(sessionId, (entries) => {
      if (outboxVerdict(entries, clientMessageId) === 'not-taken') {
        finish(false)
      }
    })
    const read = (
      submissions: readonly AgentJournalSubmission[],
      queued: readonly AgentSessionQueuedMessage[] | null | undefined
    ): void => {
      // A draft the host holds behind a running turn is that live agent's, and its card owns the
      // rest; a returned one failed to send.
      const draft = queued?.find((candidate) => candidate.messageId === clientMessageId)
      if (draft) {
        finish(draft.state === 'waiting')
        return
      }
      const submission = submissions.find(
        (entry) =>
          entry.clientMessageId === clientMessageId || entry.queuedMessageId === clientMessageId
      )
      const verdict = submission ? structuredSourcedMessageVerdict(submission) : 'waiting'
      if (verdict !== 'waiting') {
        finish(verdict === 'taken')
      }
    }
    subscribeStructuredAgentSession(
      { kind: 'local' },
      { sessionId },
      (event) => {
        if (event.type === 'snapshot' || event.type === 'reset') {
          read(event.page.submissions, event.queuedMessages ?? event.page.queuedMessages)
        } else if (event.type === 'batch') {
          read(event.batch.submissions, event.queuedMessages)
        } else {
          finish(false)
        }
      },
      () => finish(false),
      () => finish(false)
    ).then(
      (handle) => {
        unsubscribe = handle.unsubscribe
        if (settled) {
          handle.unsubscribe()
        }
      },
      () => finish(false)
    )
  })
}
