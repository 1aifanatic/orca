// When a launch prompt counts as delivered: once the host hands it to the agent. A chat's first
// message starts its agent, and the host answers the send when it accepts the message, before that
// start; a caller that writes outward on delivery (GitHub replies, cleared notes) must not do so for
// an agent that never started. Read from the session's own publication, so an older host needs no
// new field: one that predates the hand-over record answers a send only once it is handed over.

import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import { isQueuedAgentJournalSubmission } from '../../../shared/agent-session-queued-submission'
import { subscribeStructuredAgentSession } from '@/runtime/structured-agent-session-client'

/**
 * Past the longest a start can take to reach a verdict: three retried refusals wait 15 s, 60 s and
 * 5 min, and a start that never finishes is stopped by the host's idle sweep within 35 min.
 */
export const STRUCTURED_LAUNCH_PROMPT_HANDOVER_CAP_MS = 45 * 60_000

type Handover = 'handed-over' | 'not-delivered' | 'waiting'

/** `waiting` covers a start the host is still retrying: the message stays queued meanwhile. */
export function structuredLaunchPromptHandover(
  submission: Pick<AgentJournalSubmission, 'dispatchState' | 'handoverRecorded' | 'handedOverAt'>
): Handover {
  if (submission.dispatchState === 'accepted') {
    return 'handed-over'
  }
  if (submission.dispatchState === 'pending') {
    return isQueuedAgentJournalSubmission(submission) ? 'waiting' : 'handed-over'
  }
  // Rejected is a start that failed for good; unknown is a hand-over nobody can vouch for.
  return 'not-delivered'
}

/** Whether the host handed the launch prompt to the chat's agent. Anything that ends the read
 *  first (the stream failing, the cap) answers no: the caller keeps what it would have written. */
export function awaitStructuredLaunchPromptHandover(
  sessionId: string,
  clientMessageId: string,
  capMs = STRUCTURED_LAUNCH_PROMPT_HANDOVER_CAP_MS
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    let unsubscribe: (() => void) | null = null
    const finish = (delivered: boolean): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      unsubscribe?.()
      resolve(delivered)
    }
    const timer = setTimeout(() => finish(false), capMs)
    const read = (submissions: readonly AgentJournalSubmission[]): void => {
      const submission = submissions.find((entry) => entry.clientMessageId === clientMessageId)
      const handover = submission ? structuredLaunchPromptHandover(submission) : 'waiting'
      if (handover !== 'waiting') {
        finish(handover === 'handed-over')
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
