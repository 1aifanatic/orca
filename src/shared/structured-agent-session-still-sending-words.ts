// The chat line for a send Orca keeps sending under its id after a refusal it can't take as proof:
// what stopped it, if the refusal names a cause, and that Orca keeps trying. Never a step for the
// person ("send it again", "start a new chat"): following one while Orca resends could send the
// message twice.

import { agentSessionRefusalReasonWords } from './agent-session-refusal-notice'
import type { AgentSessionWriteNoticeSentence } from './agent-session-write-notice-copy'
import type { AgentSessionWriteRefusal } from './agent-session-write-failure'

/** A code's own cause, for a refusal that names no reason with words of its own. Codes whose only
 *  sentence carries a step, or says nothing but "not sent", have none. */
const CODE_CAUSES: Partial<
  Record<AgentSessionWriteRefusal['code'], AgentSessionWriteNoticeSentence>
> = {
  agent_session_owner_restart_failed: 'restartFailed',
  agent_session_operation_capacity: 'capacity',
  agent_session_item_revision_stale: 'questionChanged',
  agent_session_already_resolved: 'questionChanged',
  agent_session_journal_unreadable: 'historyUnreadable'
}

/** What stopped the write, as cause sentences only. */
function causeSentences(refusal: AgentSessionWriteRefusal): AgentSessionWriteNoticeSentence[] {
  const words = agentSessionRefusalReasonWords(refusal)
  if (words && 'cause' in words) {
    return [words.cause]
  }
  // A failure fact's one sentence carries its step ("Sign in, then…"), so it says nothing here.
  if (words && 'fact' in words) {
    return []
  }
  const cause = CODE_CAUSES[refusal.code]
  return cause ? [cause] : []
}

export function structuredAgentSessionStillSendingWords(
  refusal: AgentSessionWriteRefusal
): AgentSessionWriteNoticeSentence[] {
  return [...causeSentences(refusal), 'stillSending']
}
