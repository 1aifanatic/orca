import {
  endedRunningAgentJournalToolCall,
  type AgentJournalRunningCallEnd
} from '../../../shared/agent-journal-tool-call-lifecycle'
import type { AgentJournalItemBody } from '../../../shared/agent-session-journal-types'
import { isRunningAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import { cancelledJournalPromptBody } from './journal-prompt-body-bounds'

/** True while an item is still awaiting the row that settles it, so a sink can
 *  treat that row as lifecycle-critical rather than sheddable under pressure. */
export function requiresTerminalSettlement(body: AgentJournalItemBody): boolean {
  if (body.kind === 'tool-call') {
    return body.state === 'running'
  }
  if (body.kind === 'approval' || body.kind === 'question') {
    return body.resolution.state === 'pending'
  }
  return isRunningAgentJournalTurn(body)
}

/** The row that settles an item no one will finish: a running tool call ends as `end` (how its
 *  turn or session ended) says, a pending prompt is cancelled. Null for an item that needs none.
 *  A null `end` ends no call: another writer settled the turn, and its calls stay the provider's.
 *  Turn rows are each writer's own to end. */
export function terminalAgentJournalBody(
  body: AgentJournalItemBody,
  end: AgentJournalRunningCallEnd | null
): AgentJournalItemBody | null {
  if (body.kind === 'tool-call') {
    return body.state === 'running' && end ? endedRunningAgentJournalToolCall(body, end) : null
  }
  if (body.kind === 'approval' || body.kind === 'question') {
    return body.resolution.state === 'pending' ? cancelledJournalPromptBody(body) : null
  }
  return null
}
