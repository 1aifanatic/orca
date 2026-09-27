/** The verdict on what became of a turn, kept separate from any lifecycle state
 *  so those stay a report on what the HOST observed. `cancellation` is a stop
 *  somebody asked for, `failure` is the provider's own error, and the two are
 *  never interchangeable: only `failure` is a fault. The journal's turn record
 *  holds only these provider verdicts and never infers one. Absent always means
 *  UNKNOWN, never success. */
export const AGENT_JOURNAL_TURN_OUTCOMES = ['success', 'failure', 'cancellation'] as const
export type AgentJournalTurnOutcome = (typeof AGENT_JOURNAL_TURN_OUTCOMES)[number]

export function isAgentJournalTurnOutcome(value: unknown): value is AgentJournalTurnOutcome {
  return AGENT_JOURNAL_TURN_OUTCOMES.some((known) => known === value)
}

/** The verdict an agent-status row's `mainAgent.outcome` reports: the provider's, a `cancellation`
 *  Orca inferred from the user's own interrupt keystroke, or what the host observed of a turn's end
 *  when the provider gave no verdict. `interruption` is a death mid-turn the host proved and nobody
 *  asked for; `unconfirmed` is an end the host cannot prove, and is never success. Both are derived
 *  from the turn's lifecycle state, so the journal never stores them. */
export const AGENT_TURN_OUTCOMES = [
  ...AGENT_JOURNAL_TURN_OUTCOMES,
  'interruption',
  'unconfirmed'
] as const
export type AgentTurnOutcome = (typeof AGENT_TURN_OUTCOMES)[number]

export function isAgentTurnOutcome(value: unknown): value is AgentTurnOutcome {
  return AGENT_TURN_OUTCOMES.some((known) => known === value)
}
