import { agentChildWorkLiveness } from '../../../shared/agent-status-child-work-liveness'
import { activeStructuredAgentSessionTurnId } from '../../../shared/structured-agent-session-live-turn'
import { isQueuedAgentJournalSubmission } from '../../../shared/agent-session-queued-submission'
import type { AgentJournalSnapshot } from '../../../shared/agent-session-journal-types'
import type { AgentChildWorkView } from '../../../shared/agent-status-child-work-view'

/** Includes prompts from children, whose requests need not belong to the lead's turn. */
export function hasPendingStructuredAgentSessionPrompt(
  items: AgentJournalSnapshot['items']
): boolean {
  return items.some(
    ({ body }) =>
      (body.kind === 'approval' || body.kind === 'question') && body.resolution.state === 'pending'
  )
}

/** The same execution-host evidence governs child retirement and server retirement. */
export function structuredAgentSessionOwesWork(input: {
  snapshot: Pick<AgentJournalSnapshot, 'items' | 'submissions'>
  hasChild: boolean
  deliveryActive?: boolean
  stopping?: boolean
  childWork?: readonly AgentChildWorkView[]
  openDispatch?: boolean
  providerHoldsDispatch?: boolean
}): boolean {
  return (
    input.deliveryActive === true ||
    input.stopping === true ||
    input.snapshot.submissions.some(isQueuedAgentJournalSubmission) ||
    (input.hasChild &&
      (activeStructuredAgentSessionTurnId(input.snapshot.items) !== null ||
        input.snapshot.submissions.some(({ dispatchState }) => dispatchState === 'pending') ||
        agentChildWorkLiveness(input.childWork) !== null ||
        input.openDispatch === true ||
        input.providerHoldsDispatch === true ||
        hasPendingStructuredAgentSessionPrompt(input.snapshot.items)))
  )
}
