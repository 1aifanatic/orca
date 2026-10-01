// How a provider's Stop, and a prompt card's own controls, end what they end. Every member is
// optional: a provider that declares none keeps its child after a Stop, its card's Cancel interrupts
// the turn holding the card, and a card's option goes to it as picked.

/** Where a card's control goes: one of the approval's own options, or the chat's Stop. */
export type AgentSessionPromptRoute = { kind: 'option'; optionId: string } | { kind: 'stop' }

export type StructuredAgentSessionAdapterStop = {
  /** A Stop ends this provider's child after `cancelTurn`, whatever it answered, unless it named a
   *  turn that is no longer live and the cancel answered that it did not take it; the next send
   *  resumes the conversation. Absent or false keeps the child after a Stop. */
  stopEndsSession?(sessionId: string): boolean
  /** What a Stop that ends the session waits on before it ends the child: resolves at once when
   *  `turnId` is not the provider's open turn, else when it ends or the provider's grace, counted
   *  from `stoppedAt` (when the interrupt went out), runs out. */
  awaitStoppedTurnEnd?(sessionId: string, turnId: string, stoppedAt: number): Promise<void>
  /** Where a card's own Cancel (no `optionId`), or one of its options, goes. Undefined: the Cancel
   *  goes to `cancelTurn` with the prompt, and the option to `answerPrompt`. */
  routePromptAnswer?(
    sessionId: string,
    kind: 'approval' | 'question',
    optionId?: string
  ): AgentSessionPromptRoute | undefined
}
