// Why a host keeps a chat read-only, as it publishes it beside the chat's history, and the words a
// chat surface shows for it. The host owns the fact; a surface only says it.

import type { AgentSessionWriteNoticeSentence } from './agent-session-write-notice-copy'

/** Every latch a host has is a newer Orca's: its database, row version, row kind or content. */
export const AGENT_SESSION_READ_ONLY_REASONS = ['written-by-newer-orca'] as const
export type AgentSessionReadOnlyReason = (typeof AGENT_SESSION_READ_ONLY_REASONS)[number]

/** The words for a reason this client knows, shown as the locked composer's placeholder; none
 *  for one a newer host names, which this client cannot word truthfully. */
export function agentSessionReadOnlyNoticeParts(
  reason: AgentSessionReadOnlyReason | undefined
): AgentSessionWriteNoticeSentence[] | null {
  return reason === 'written-by-newer-orca'
    ? ['chatSavedByNewerOrca', 'updateOrcaToContinueChat']
    : null
}
