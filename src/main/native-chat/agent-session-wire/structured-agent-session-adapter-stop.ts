// How a provider's Stop, and a prompt card's own Cancel, end what they end. Every member is
// optional: a provider that declares none keeps its child after a Stop, and its card's Cancel
// interrupts the turn holding the card.

import type {
  AgentJournalApprovalItem,
  AgentJournalQuestionItem
} from '../../../shared/agent-session-journal-types'

/** Where a card's Cancel goes: an approval answer, sent as if the user picked it, or the chat's
 *  Stop. The answer may be one the card does not offer, such as a dismissal. */
export type AgentSessionPromptCancelRoute = { kind: 'option'; optionId: string } | { kind: 'stop' }

export type StructuredAgentSessionAdapterStop = {
  /** A Stop ends this provider's child after `cancelTurn`, whatever it answered, unless it named a
   *  turn that is no longer live and the cancel answered that it did not take it; the next send
   *  resumes the conversation. Absent or false keeps the child after a Stop. */
  stopEndsSession?(sessionId: string): boolean
  /** What a Stop that ends the session waits on before it ends the child: resolves at once when
   *  `turnId` is not the provider's open turn, else when it ends or the provider's grace, counted
   *  from `stoppedAt` (when the interrupt went out), runs out. */
  awaitStoppedTurnEnd?(sessionId: string, turnId: string, stoppedAt: number): Promise<void>
  /** Where the pending card's own Cancel goes. Undefined: `cancelTurn` with the prompt. */
  routePromptCancel?(input: {
    sessionId: string
    prompt: AgentJournalApprovalItem | AgentJournalQuestionItem
  }): AgentSessionPromptCancelRoute | undefined
}
