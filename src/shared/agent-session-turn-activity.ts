// The live turn activity a host publishes beside the journal: the provider's words for what the
// turn is doing, and which reasoning is open right now.

export type AgentSessionTurnActivity = {
  turnId: string
  /** The provider's own words; '' when the host reports only open reasoning. */
  text: string
  /** Who has a reasoning block or item open in this turn right now. Absent from older hosts and
   *  when nothing is open. */
  reasoning?: AgentSessionOpenReasoning
}

/** `subagents` names producer agentIds, the ids subagent sections are keyed by. */
export type AgentSessionOpenReasoning = { session: boolean; subagents: string[] }

/** One equality for the host that decides what to publish and every client that decides what
 *  changed; null and absent both mean no activity. */
export function agentSessionTurnActivityEqual(
  a: AgentSessionTurnActivity | null | undefined,
  b: AgentSessionTurnActivity | null | undefined
): boolean {
  if (!a || !b) {
    return !a && !b
  }
  return (
    a.turnId === b.turnId &&
    a.text === b.text &&
    a.reasoning?.session === b.reasoning?.session &&
    (a.reasoning?.subagents ?? []).join('\n') === (b.reasoning?.subagents ?? []).join('\n')
  )
}
