import type {
  AgentSessionOpenReasoning,
  AgentSessionTurnActivity
} from '../../../shared/agent-session-wire'
import type { StructuredAgentSessionEventSink } from './structured-agent-session-event-sink'

/** Bounds the published list; a turn running more reasoning subagents at once is not plausible. */
export const MAX_OPEN_REASONING_SUBAGENTS = 32

const NOTHING_OPEN: AgentSessionOpenReasoning = { session: false, subagents: [] }

export type TurnActivityChannel = {
  /** The provider's words for the turn: '' or null clears them, undefined leaves them. */
  setText: (turnId: string, text: string | null | undefined) => void
  /** Who has reasoning open in the turn, as the provider's tracker last derived it. */
  setReasoning: (turnId: string | null, reasoning: AgentSessionOpenReasoning) => void
  /** The turn ended or a new one opened: nothing it said is current any more. */
  clear: () => void
}

function isOpen(reasoning: AgentSessionOpenReasoning): boolean {
  return reasoning.session || reasoning.subagents.length > 0
}

function sameActivity(
  a: AgentSessionTurnActivity | null,
  b: AgentSessionTurnActivity | null
): boolean {
  if (a === null || b === null) {
    return a === b
  }
  return (
    a.turnId === b.turnId &&
    a.text === b.text &&
    a.reasoning?.session === b.reasoning?.session &&
    (a.reasoning?.subagents ?? []).join('\n') === (b.reasoning?.subagents ?? []).join('\n')
  )
}

/** One turn's live activity line, composed from the provider's words and its open reasoning, so
 *  neither writer overwrites the other. */
export function createTurnActivityChannel(
  sink: Pick<StructuredAgentSessionEventSink, 'setActivity'>
): TurnActivityChannel {
  let turnId: string | null = null
  let text = ''
  let reasoning = NOTHING_OPEN
  let published: AgentSessionTurnActivity | null = null

  const retarget = (next: string): void => {
    if (next !== turnId) {
      turnId = next
      text = ''
      reasoning = NOTHING_OPEN
    }
  }
  const publish = (force = false): void => {
    const next: AgentSessionTurnActivity | null =
      turnId !== null && (text || isOpen(reasoning))
        ? { turnId, text, ...(isOpen(reasoning) ? { reasoning } : {}) }
        : null
    if (force || !sameActivity(next, published)) {
      published = next
      sink.setActivity?.(next)
    }
  }

  return {
    setText: (next, value) => {
      if (value === undefined) {
        return
      }
      retarget(next)
      text = value ?? ''
      // A cleared line is always sent, as before: an attach may still hold an earlier one.
      publish(!value)
    },
    setReasoning: (next, value) => {
      if (next === null) {
        if (isOpen(reasoning)) {
          reasoning = NOTHING_OPEN
          publish()
        }
        return
      }
      retarget(next)
      reasoning = {
        session: value.session,
        subagents: [...new Set(value.subagents)].sort().slice(0, MAX_OPEN_REASONING_SUBAGENTS)
      }
      publish()
    },
    clear: () => {
      turnId = null
      text = ''
      reasoning = NOTHING_OPEN
      publish(true)
    }
  }
}
