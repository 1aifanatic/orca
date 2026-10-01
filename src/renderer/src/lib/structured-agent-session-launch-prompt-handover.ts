// When a launch prompt counts as delivered: once the agent has taken it. A chat's first message
// starts its agent, and the host answers the send when it accepts the message, before that start;
// a caller that writes outward on delivery (GitHub replies, cleared notes) must not do so for an
// agent that never started. So the wait follows the message to its own final state, read from the
// session's publication: no new wire field, and no timer of its own. A start the host retries
// keeps the message queued, and the retry schedule ends in a verdict.

import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import { subscribeStructuredAgentSession } from '@/runtime/structured-agent-session-client'

type LaunchPromptVerdict = 'taken' | 'not-taken' | 'waiting'

export function structuredLaunchPromptVerdict(
  submission: Pick<AgentJournalSubmission, 'dispatchState'>
): LaunchPromptVerdict {
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

// One read per launch prompt, whoever asks.
const inFlight = new Map<string, Promise<boolean>>()

/** Whether the chat's agent took the launch prompt: only accepted or rejected answer it. Anything
 *  that ends the read first (the stream ending or failing) answers no: the caller keeps what it
 *  would have written. */
export function awaitStructuredLaunchPromptTaken(
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
      unsubscribe?.()
      resolve(taken)
    }
    const read = (submissions: readonly AgentJournalSubmission[]): void => {
      const submission = submissions.find((entry) => entry.clientMessageId === clientMessageId)
      const verdict = submission ? structuredLaunchPromptVerdict(submission) : 'waiting'
      if (verdict !== 'waiting') {
        finish(verdict === 'taken')
      }
    }
    subscribeStructuredAgentSession(
      { kind: 'local' },
      { sessionId },
      (event) => {
        if (event.type === 'snapshot' || event.type === 'reset') {
          read(event.page.submissions)
        } else if (event.type === 'batch') {
          read(event.batch.submissions)
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
