import type { ProviderTimelineEvent } from '../native-chat/agent-session-timeline/provider-timeline-event'

export type AcpPromptTurn = {
  clientMessageId: string
  turn: string
  requestedAt: number
  opened: boolean
  durationMs?: number
}

const PROMPT_TURN_PREFIX = 'prompt:'

/** The send behind a turn Orca's own prompt opened; undefined for a turn the agent began. */
export function acpPromptClientMessageId(turn: string): string | undefined {
  return turn.startsWith(PROMPT_TURN_PREFIX) ? turn.slice(PROMPT_TURN_PREFIX.length) : undefined
}

/** An injected identity is known before any provider output arrives. */
export class AcpPromptTurns {
  current?: AcpPromptTurn

  constructor(
    private readonly sessionId: string,
    private readonly injected: boolean
  ) {}

  open(clientMessageId: string, at: number): { promptId: string; events: ProviderTimelineEvent[] } {
    if (this.current) {
      throw new Error('ACP prompt overlaps a prompt or load')
    }
    const turn = `${PROMPT_TURN_PREFIX}${clientMessageId}`
    this.current = { clientMessageId, turn, requestedAt: at, opened: false }
    return { promptId: turn, events: this.injected ? [] : this.start(turn, at) }
  }

  start(turn: string, at: number): ProviderTimelineEvent[] {
    const prompt = this.current
    if (prompt?.turn !== turn || prompt.opened) {
      return []
    }
    prompt.opened = true
    return [
      { type: 'turn.open', turn, at },
      {
        type: 'input.accepted',
        clientMessageId: prompt.clientMessageId,
        requestedAt: prompt.requestedAt,
        join: { thread: this.sessionId, turn }
      }
    ]
  }
}

export function acpTurnEnd(
  turn: string,
  stopReason: string,
  at: number,
  durationMs?: number
): ProviderTimelineEvent {
  return {
    type: 'turn.end',
    turn,
    at,
    state: stopReason === 'cancelled' ? 'interrupted' : 'completed',
    ...(stopReason === 'end_turn'
      ? { outcome: 'success' as const }
      : stopReason === 'cancelled'
        ? { outcome: 'cancellation' as const }
        : ['refusal', 'max_tokens', 'max_turn_requests', 'error', 'rate_limit'].includes(stopReason)
          ? { outcome: 'failure' as const }
          : {}),
    ...(durationMs === undefined ? {} : { durationMs })
  }
}
