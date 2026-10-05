import type { AgentSessionUnavailable } from '../../../../shared/agent-session-availability'
import { agentSessionSignInCopyId } from '../../../../shared/agent-session-availability'
import type { AgentType } from '../../../../shared/agent-status-types'
import type { NativeChatComposerImageAttachment } from './NativeChatComposerField'
import { sayAgentSessionFailureTranslated } from './agent-session-failure-words-text'

export function nativeChatComposerSendState(
  input: {
    agent: AgentType
    isWorking: boolean
    hasPty: boolean
    onStop?: () => void
    disabled: boolean
  },
  draft: string,
  attachments: readonly NativeChatComposerImageAttachment[],
  unavailable: AgentSessionUnavailable | null | undefined
): { sendButtonDisabled: boolean; sendDisabledReason: string | undefined } {
  // A pending image has no agent-readable path yet.
  const hasPendingAttachment = attachments.some((attachment) => attachment.pending)
  const sendButtonDisabled = input.isWorking
    ? !input.hasPty || !input.onStop
    : input.disabled ||
      hasPendingAttachment ||
      (draft.trim() === '' && attachments.length === 0) ||
      Boolean(unavailable)
  const sendDisabledReason = unavailable
    ? unavailable.reason === 'cliMissing'
      ? sayAgentSessionFailureTranslated('cliMissing', {
          agent: input.agent === 'codex' ? 'Codex' : 'Claude'
        })
      : sayAgentSessionFailureTranslated(
          agentSessionSignInCopyId(
            input.agent === 'codex' ? 'codex' : 'claude',
            unavailable.account
          )
        )
    : undefined
  return { sendButtonDisabled, sendDisabledReason }
}
