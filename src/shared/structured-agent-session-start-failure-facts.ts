// The failures a chat's loaded start-failure rows state, so a message that start rejected need not
// say why again. Shared so the desktop and the phone match a rejection to its row the same way.

import { readAgentSessionFailureFact, type AgentSessionFailureFact } from './agent-session-failure'
import type { AgentJournalRenderItem } from './agent-session-journal-types'
import { isStructuredAgentSessionStartFailureRow } from './structured-agent-session-start-failure-row-key'

/** The facts the chat's loaded start-failure rows state. */
export function structuredAgentSessionStartFailureFacts(
  items: readonly AgentJournalRenderItem[]
): AgentSessionFailureFact[] {
  const facts: AgentSessionFailureFact[] = []
  for (const item of items) {
    if (item.body.kind === 'status' && isStructuredAgentSessionStartFailureRow(item.itemId)) {
      const fact = readAgentSessionFailureFact(item.body.failure)
      if (fact) {
        facts.push(fact)
      }
    }
  }
  return facts
}

/** Whether two facts are one failure: a start's row and the messages it rejected share one. */
export function sameAgentSessionFailureFact(
  a: AgentSessionFailureFact,
  b: AgentSessionFailureFact
): boolean {
  return (
    a.kind === b.kind &&
    a.detail?.text === b.detail?.text &&
    a.detail?.audience === b.detail?.audience &&
    a.refusal?.code === b.refusal?.code &&
    a.refusal?.details?.reason === b.refusal?.details?.reason &&
    a.attachment?.reason === b.attachment?.reason &&
    a.attachment?.limit === b.attachment?.limit &&
    a.retry?.error === b.retry?.error &&
    a.retry?.status === b.retry?.status
  )
}

/** Whether a loaded start-failure row already states this failure. Matching is identity, not
 *  wording: what this build can read is enough. */
export function agentSessionFailureStatedByStartRow(
  failure: unknown,
  startFailures: readonly AgentSessionFailureFact[]
): boolean {
  const fact = readAgentSessionFailureFact(failure)
  return (
    fact !== undefined && startFailures.some((stated) => sameAgentSessionFailureFact(stated, fact))
  )
}
