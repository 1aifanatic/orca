// A failed start's one row is keyed by the start, so a reader finds it by identity, not by its words.

import { parseAgentJournalItemKey } from './agent-session-journal-item-key'
import type { AgentJournalItemIdentity } from './agent-session-journal-types'

const START_FAILURE_ROW = 'start-failure:'

export function structuredAgentSessionStartFailureRowIdentity(
  startKey: string
): Extract<AgentJournalItemIdentity, { provider: 'orca' }> {
  return { provider: 'orca', clientMessageId: `${START_FAILURE_ROW}${startKey}` }
}

/** The start a start-failure row is for; null for any other row. */
export function structuredAgentSessionStartFailureRowStartKey(itemId: string): string | null {
  const identity = parseAgentJournalItemKey(itemId)
  if (identity?.provider !== 'orca' || !identity.clientMessageId.startsWith(START_FAILURE_ROW)) {
    return null
  }
  return identity.clientMessageId.slice(START_FAILURE_ROW.length) || null
}
