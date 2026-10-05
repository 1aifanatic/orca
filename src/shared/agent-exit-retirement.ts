/**
 * The origin of an agent-exit observation, captured when the exit was observed and carried
 * unchanged to the mutation that retires the pane's chat. A conditional fence, never send
 * authority: a later presentation change or rebinding makes the retirement a no-op.
 */
export type AgentExitRetirementCondition = {
  leafId: string
  /** The PTY the exit was seen on; absent from a paired client, whose ids are not the host's. */
  ptyId?: string
  /** Same-machine origin: any presentation change at or after this instant supersedes the exit. */
  observedAtMs?: number
  /** Cross-host origin: the host's presentation token when the exit was observed. */
  presentationToken?: string
}

/** What a pane's exit callback carries from the moment the exit was observed. */
export type AgentExitObservationOrigin = { ptyId: string | null; observedAtMs: number }

/** `unchanged`: nothing left to retire (already terminal, no hint). Only `applied` mutated. */
export type AgentExitRetirementDisposition = 'applied' | 'unchanged' | 'superseded' | 'missing'

export const AGENT_EXIT_RETIREMENT_DISPOSITIONS: readonly AgentExitRetirementDisposition[] = [
  'applied',
  'unchanged',
  'superseded',
  'missing'
]

export function readAgentExitRetirementCondition(
  value: unknown
): AgentExitRetirementCondition | undefined {
  if (!value || typeof value !== 'object') {
    return undefined
  }
  const record: Record<string, unknown> = { ...value }
  const { leafId, ptyId, observedAtMs, presentationToken } = record
  if (typeof leafId !== 'string' || !leafId || leafId.length > 128) {
    return undefined
  }
  return {
    leafId,
    ...(typeof ptyId === 'string' && ptyId && ptyId.length <= 256 ? { ptyId } : {}),
    ...(typeof observedAtMs === 'number' && Number.isFinite(observedAtMs) ? { observedAtMs } : {}),
    ...(typeof presentationToken === 'string' && presentationToken.length <= 128
      ? { presentationToken }
      : {})
  }
}
