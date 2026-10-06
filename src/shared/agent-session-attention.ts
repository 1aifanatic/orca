// The identity and wording of one structured attention edge, shared by every surface that
// announces it: the desktop's banner and unread, and the execution host's own phone push.

import { agentSessionScopeKey, type AgentSessionExecutionLocation } from './agent-session-record'
import type { AgentSessionTurnCompletionEvent } from './agent-session-wire'
import { AGENT_JOURNAL_TURN_OUTCOMES, type AgentJournalTurnOutcome } from './agent-turn-outcome'

/** What the host says needs the user: a settled request, or a prompt it raised. */
export type AgentSessionAttentionEdge = Extract<
  AgentSessionTurnCompletionEvent,
  { type: 'completion' | 'prompt' }
>

/** Every attention key this host can mint for one session starts with this: what acknowledging
 *  the session retires. */
export function agentSessionAttentionSubjectPrefix(
  scope: AgentSessionExecutionLocation,
  sessionId: string
): string {
  const parts = ['agent-attention', agentSessionScopeKey(scope), sessionId]
  return `${parts.map(encodeURIComponent).join(':')}:`
}

/** One edge's identity, shared by every surface that announces it: the desktop banner, the host's
 *  mobile push and their retirement all use it, and delivery dedupes on it rather than a time window. */
export function agentSessionAttentionKey(edge: AgentSessionAttentionEdge): string {
  if (edge.type === 'prompt') {
    return agentSessionPromptAttentionKey(
      edge.prompt.scope,
      edge.prompt.sessionId,
      edge.prompt.promptId
    )
  }
  const { scope, sessionId, turnId } = edge.completion
  return `${agentSessionAttentionSubjectPrefix(scope, sessionId)}turn:${encodeURIComponent(turnId)}`
}

export function agentSessionPromptAttentionKey(
  scope: AgentSessionExecutionLocation,
  sessionId: string,
  promptId: string
): string {
  return `${agentSessionAttentionSubjectPrefix(scope, sessionId)}prompt:${encodeURIComponent(promptId)}`
}

/** What one edge tells the user, worded once for every surface; null when it tells nothing.
 *  `blocked` is the row's "needs input". */
export function agentSessionAttentionNews(
  edge: AgentSessionAttentionEdge
): { agentState: 'blocked' | 'done'; outcome?: AgentJournalTurnOutcome } | null {
  if (edge.type === 'prompt') {
    return { agentState: 'blocked' }
  }
  const { outcome, awaitingUser } = edge.completion
  // ABSENT OUTCOME IS UNKNOWN: a host that predates the field must not read as any verdict.
  if (!AGENT_JOURNAL_TURN_OUTCOMES.includes(outcome)) {
    return null
  }
  // A failure is news of its own even while a prompt waits; only a clean settle reads as the prompt.
  return {
    agentState: awaitingUser === true && outcome === 'success' ? 'blocked' : 'done',
    outcome
  }
}
