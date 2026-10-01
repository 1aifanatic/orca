// Whether a conversation command may run at its handover: refused, run, or left queued behind
// work that went ahead of it while it waited out a refused start.

import {
  agentSessionFailureFact,
  type SubmissionRejectionFact
} from '../../../shared/agent-session-failure'
import {
  agentJournalSubmissionKey,
  parseAgentJournalItemKey
} from '../../../shared/agent-session-journal-item-key'
import type {
  AgentJournalMessageItem,
  AgentJournalSubmission
} from '../../../shared/agent-session-journal-types'
import { isQueuedAgentJournalSubmission } from '../../../shared/agent-session-queued-submission'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import { agentSessionRefusalReference } from '../../../shared/agent-session-wire-refusals'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import {
  STRUCTURED_AGENT_SESSION_COMPACT_COMMAND,
  type StructuredAgentSessionCommandHandoverContext
} from './structured-agent-session-command-turn'
import { conversationCommandBlocked } from './structured-conversation-command-admission'

/** Why the command may not run now, as the fact its message is rejected with; null when it may,
 *  and `waits` when only work accepted after it is in the way. */
export function commandBlocked(
  ctx: StructuredAgentSessionCommandHandoverContext,
  submission: AgentJournalSubmission,
  body: AgentJournalMessageItem
): SubmissionRejectionFact | 'waits' | null {
  if (body.command?.name !== STRUCTURED_AGENT_SESSION_COMPACT_COMMAND || !ctx.adapter.compact) {
    return agentSessionFailureFact('commandRefused')
  }
  const record = ctx.record()
  if (!record) {
    return agentSessionFailureFact('hostFault')
  }
  const refusal = conversationCommandBlocked(ctx, record, ctx.childWork(), 'handover')
  if (!refusal) {
    return null
  }
  return blockedOnlyByLaterWork(ctx, submission, refusal.details?.reason)
    ? 'waits'
    : agentSessionFailureFact('commandRefused', { refusal: agentSessionRefusalReference(refusal) })
}

/** A command waiting out a refused start lets later messages go first; what they are still doing
 *  when its try comes is theirs, not a reason to refuse it. It waits: their end is a commit, which
 *  wakes the loop again. */
function blockedOnlyByLaterWork(
  ctx: StructuredAgentSessionCommandHandoverContext,
  submission: AgentJournalSubmission,
  reason: string | undefined
): boolean {
  const since = submission.acceptedSequence
  // Only a command that waited out a refused start was gone past.
  if (since === undefined || submission.startFailure === undefined) {
    return false
  }
  const acceptedAfter = (clientMessageId: string): boolean =>
    (ctx.journal.submissions().find((entry) => entry.clientMessageId === clientMessageId)
      ?.acceptedSequence ?? 0) > since
  if (reason === 'turnActive') {
    const items = ctx.journal.snapshot().items
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const turn = readAgentJournalTurn(items[index]?.body)
      if (turn) {
        // A turn the provider opened on its own is not a later message's.
        const sentBy = turn.userItemId ? parseAgentJournalItemKey(turn.userItemId) : null
        return (
          turn.state === 'running' &&
          sentBy !== null &&
          'clientMessageId' in sentBy &&
          acceptedAfter(sentBy.clientMessageId)
        )
      }
    }
    return false
  }
  if (reason === 'messagesUnsettled') {
    // The same unsettled sends `conversationCommandBlocked` reads at a handover.
    const unsettled = ctx.journal
      .submissions()
      .filter(
        (entry) =>
          (entry.dispatchState === 'pending' && !isQueuedAgentJournalSubmission(entry)) ||
          (entry.dispatchState === 'unknown' &&
            entry.recovered !== true &&
            entry.fence === ctx.fence)
      )
    return unsettled.every((entry) => (entry.acceptedSequence ?? 0) > since)
  }
  return false
}

/** A command that waited out a refused start, now behind a turn a later message runs: that turn's
 *  end is the commit that can let it go, so the commits before it need not wake the loop. */
export function structuredAgentSessionCommandWaitsOnTurn(
  journal: Pick<AgentSessionJournal, 'itemBody' | 'activeTurnId'>,
  submission: AgentJournalSubmission
): boolean {
  const body = journal.itemBody(agentJournalSubmissionKey(submission.clientMessageId))
  return (
    submission.startFailure !== undefined &&
    body?.kind === 'message' &&
    body.command !== undefined &&
    journal.activeTurnId() !== null
  )
}
