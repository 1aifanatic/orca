// Render models for the host-held queued drafts shown above the composer.
// The wire carries no hold copy on purpose: the label is derived here from the
// draft's own state plus the live facts the client already holds.

import { readAgentSessionFailureFact } from '../../../src/shared/agent-session-failure'
import type { AgentJournalSubmission } from '../../../src/shared/agent-session-journal-types'
import { agentSessionWriteNoticeEnglish } from '../../../src/shared/agent-session-refusal-notice'
import { dispatchWasWithdrawn } from '../../../src/shared/structured-agent-session-dispatch-rejection'
import { structuredAgentSessionAttemptFailureParts } from '../../../src/shared/structured-agent-session-send-disposition'
import {
  QUEUED_MESSAGE_PAUSED_SEND_FAILED,
  type AgentSessionQueuedMessage,
  type AgentSessionQueuePause
} from '../../../src/shared/agent-session-wire'

export type MobileQueuedMessageCard = {
  messageId: string
  /** The draft's text blocks joined for display and for Edit's composer copy. */
  text: string
  state: 'waiting' | 'returned'
  paused: boolean
  /** One-line status under the text. */
  label: string
}

function queuedMessageBodyText(body: AgentSessionQueuedMessage['body']): string {
  return body.blocks.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n')
}

function returnedLabel(
  draft: Pick<AgentSessionQueuedMessage, 'returnedReason' | 'returnedRejection'>
): string {
  const reason = draft.returnedReason ?? null
  const rejection = draft.returnedRejection
  if (dispatchWasWithdrawn({ dispatchState: 'rejected', reason, rejection })) {
    return 'Stopped before it was sent'
  }
  // Worded as the desktop card words it: the fact decides, the reason is the fallback, and the
  // card's own Send is the retry, so the words leave out sending again.
  return agentSessionWriteNoticeEnglish(
    structuredAgentSessionAttemptFailureParts(
      { kind: 'rejected', reason },
      { retryControl: true },
      readAgentSessionFailureFact(rejection)
    )
  )
}

/** One card's own hold: only a failed conversion; the queue's pause is its header row. */
function pausedLabel(reason: string | undefined): string {
  if (reason === QUEUED_MESSAGE_PAUSED_SEND_FAILED) {
    return "Couldn't send — tap Send to retry"
  }
  // Absent or unknown (newer host) marker: a plain pause, promising no release rule.
  return 'Paused'
}

const QUEUE_PAUSE_LABELS: Readonly<Record<string, string>> = {
  stopped: 'Queue paused because you interrupted',
  restarted: 'Queue paused because Orca restarted',
  cleared: 'Queue paused after you cleared the conversation'
}

/** The paused queue's header row. A reason this build does not know (a newer host's) reads as a
 *  plain pause. */
export function mobileQueuePauseLabel(pause: Pick<AgentSessionQueuePause, 'reason'>): string {
  return QUEUE_PAUSE_LABELS[pause.reason] ?? 'Queue paused'
}

/** Cards in published order. A waiting card is hidden once a live hand-off of it arrived — a
 *  submission naming it as its `queuedMessageId` that was not rejected — as the desktop hides it:
 *  on a multi-page catch-up the shrunk list rides only the final page, so the bubble and the card
 *  would otherwise briefly show together. A rejected hand-off is what sent the draft back, so it
 *  hides nothing. Returned cards always show. */
export function mobileQueuedMessageCards(
  queuedMessages: readonly AgentSessionQueuedMessage[] | null,
  submissions: readonly Pick<AgentJournalSubmission, 'queuedMessageId' | 'dispatchState'>[],
  facts: { pendingPrompt: boolean; queuePaused?: boolean }
): MobileQueuedMessageCard[] {
  if (!queuedMessages || queuedMessages.length === 0) {
    return []
  }
  const handedOff = new Set(
    submissions.flatMap((submission) =>
      submission.queuedMessageId !== undefined && submission.dispatchState !== 'rejected'
        ? [submission.queuedMessageId]
        : []
    )
  )
  let behindReturned = false
  const cards: MobileQueuedMessageCard[] = []
  for (const draft of queuedMessages) {
    if (draft.state !== 'returned' && handedOff.has(draft.messageId)) {
      continue
    }
    const paused = draft.paused === true
    const label =
      draft.state === 'returned'
        ? returnedLabel(draft)
        : paused
          ? pausedLabel(draft.pausedReason)
          : behindReturned
            ? 'Waiting — a message ahead needs attention'
            : facts.queuePaused
              ? // The header row says why and offers Resume; the card promises no send time.
                'Queued'
              : facts.pendingPrompt
                ? 'Waiting for your answer'
                : 'Queued — sends when the current turn ends'
    cards.push({
      messageId: draft.messageId,
      text: queuedMessageBodyText(draft.body),
      state: draft.state,
      paused,
      label
    })
    if (draft.state === 'returned') {
      behindReturned = true
    }
  }
  return cards
}
