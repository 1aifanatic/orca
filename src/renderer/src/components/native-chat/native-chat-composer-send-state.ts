import {
  agentSessionSignInCopyId,
  type AgentSessionUnavailable
} from '../../../../shared/agent-session-availability'
import type { AgentType } from '../../../../shared/agent-status-types'
import type { NativeChatComposerImageAttachment } from './NativeChatComposerField'
import { sayAgentSessionFailureTranslated } from './agent-session-failure-words-text'
import { nativeChatImageSendBlock } from './native-chat-image-reattach'

/** The one rule for when the host's verdict blocks Send: only a send that starts the agent. While
 *  a turn runs, Send is Stop and a follow-up queues behind it as it always has. Applied once, where
 *  the session hands the verdict to its composer, so the button, Enter and goal mode all read the
 *  same value. */
export function nativeChatComposerSendGate(
  unavailable: AgentSessionUnavailable | null | undefined,
  isWorking: boolean
): AgentSessionUnavailable | null {
  return isWorking ? null : (unavailable ?? null)
}

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
  /** The transport's verdict, already gated by `nativeChatComposerSendGate`. */
  unavailable: AgentSessionUnavailable | null
): { sendButtonDisabled: boolean; sendBlockedReason: string | undefined } {
  const imageBlock = nativeChatImageSendBlock(attachments)
  const sendButtonDisabled = input.isWorking
    ? !input.hasPty || !input.onStop
    : input.disabled ||
      imageBlock.holdsSend ||
      (draft.trim() === '' && attachments.length === 0) ||
      Boolean(unavailable)
  const provider = input.agent === 'codex' ? 'codex' : 'claude'
  const sendBlockedReason = unavailable
    ? unavailable.reason === 'cliMissing'
      ? sayAgentSessionFailureTranslated('cliMissing', {
          agent: provider === 'codex' ? 'Codex' : 'Claude'
        })
      : sayAgentSessionFailureTranslated(agentSessionSignInCopyId(provider, unavailable.account))
    : (imageBlock.reason ?? undefined)
  return { sendButtonDisabled, sendBlockedReason }
}
