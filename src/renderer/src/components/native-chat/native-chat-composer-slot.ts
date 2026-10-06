import type { AgentJournalItemBody } from '../../../../shared/agent-session-journal-types'
import { pendingPromptsAllUnanswerableHere } from '../../../../shared/agent-session-approval-subject'

/** The prompt card standing in the composer's slot, or null when the composer shows. A prompt this
 *  build cannot answer leaves the composer open: a send starts a turn, whose card cancel works. */
export function promptHoldingComposerSlot(
  prompts: readonly { body: AgentJournalItemBody }[]
): 'question' | 'approval' | null {
  const first = prompts[0]
  if (!first || pendingPromptsAllUnanswerableHere(prompts)) {
    return null
  }
  return first.body.kind === 'question' ? 'question' : 'approval'
}
