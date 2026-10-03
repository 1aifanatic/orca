// Whether the user has seen an agent's current state: the one rule that un-bolds a sidebar row,
// lets auto-acknowledgement skip a pane, clears an Activity unread and, for a turn cut short with
// nobody asking, drops its red mark.

/** An agent's current state beside the newest time the user acknowledged it, joined where the
 *  entry is read so no surface can leave the acknowledgement out. */
export type AgentTurnAcknowledgement = {
  /** When the agent entered its current state. */
  stateStartedAt: number
  /** When the user last acknowledged the agent; undefined when never. */
  acknowledgedAt: number | undefined
}

/** Compared with `stateStartedAt`, not the newest update, so a same-state ping is not new news. */
export function isAgentTurnAcknowledged({
  stateStartedAt,
  acknowledgedAt
}: AgentTurnAcknowledgement): boolean {
  return (acknowledgedAt ?? 0) >= stateStartedAt
}
