import type { AgentSessionUnavailable } from '../../../../shared/agent-session-availability'
import { agentSessionSignInCopyId } from '../../../../shared/agent-session-availability'
import type { AgentType } from '../../../../shared/agent-status-types'
import type { NativeChatComposerImageAttachment } from './NativeChatComposerField'
import { sayAgentSessionFailureTranslated } from './agent-session-failure-words-text'
import { nativeChatImageSendBlock } from './native-chat-image-reattach'

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
): { sendButtonDisabled: boolean; sendBlockedReason: string | undefined } {
  const imageBlock = nativeChatImageSendBlock(attachments)
  const sendButtonDisabled = input.isWorking
    ? !input.hasPty || !input.onStop
    : input.disabled ||
      imageBlock.holdsSend ||
      (draft.trim() === '' && attachments.length === 0) ||
      Boolean(unavailable)
  const sendBlockedReason = unavailable
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
    : (imageBlock.reason ?? undefined)
  return { sendButtonDisabled, sendBlockedReason }
}
