/**
 * What a desktop click still owes once its launch's prompt has landed: notes to mark sent, review
 * threads to resolve. Recorded on the launch's own row (the operation ledger) so a window that
 * reloads mid-launch can still run it, once. It dies when the window takes it, or with the row.
 *
 * Opaque to the host. `kind` and `version` say how the window reads `payload`; a window that does
 * not know the pair discards it rather than misreading a shape another build wrote.
 */
export type AgentLaunchFollowUp = {
  kind: string
  version: number
  payload: unknown
}

/** Bigger than any notes or comment selection a click sends; anything larger stays live-only. */
export const AGENT_LAUNCH_FOLLOW_UP_MAX_BYTES = 256 * 1024

const encoder = new TextEncoder()

/** Whether the follow-up may be recorded; one that is not still runs live, as before. */
export function agentLaunchFollowUpFits(followUp: AgentLaunchFollowUp): boolean {
  try {
    return encoder.encode(JSON.stringify(followUp)).byteLength <= AGENT_LAUNCH_FOLLOW_UP_MAX_BYTES
  } catch {
    return false
  }
}

export function isAgentLaunchFollowUp(value: unknown): value is AgentLaunchFollowUp {
  return (
    typeof value === 'object' &&
    value !== null &&
    'kind' in value &&
    typeof value.kind === 'string' &&
    'version' in value &&
    typeof value.version === 'number' &&
    'payload' in value
  )
}

/** What the window's take returns for one launch. */
export type TakenAgentLaunchFollowUp = {
  operationId: string
  followUp: AgentLaunchFollowUp
  /** The launch handed its prompt to the agent; false when it never did, and nothing may run. */
  promptHandedOver: boolean
  /** The host wrote the prompt without seeing the agent's composer ready. */
  composerUnobserved: boolean
}

export type AgentLaunchFollowUpTake = {
  /** Removed from the record: this caller now owns running them. */
  taken: TakenAgentLaunchFollowUp[]
  /** Still waiting on their prompt; left on the record, read-only. `deadline`: when the host stops
   *  trying to deliver it, for a waiting window to stop holding what it acts on. */
  pending: { operationId: string; followUp: AgentLaunchFollowUp; deadline?: number }[]
}
