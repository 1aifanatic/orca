import type { AgentSessionUnavailable } from '../../../../shared/agent-session-availability'
import { agentSessionSignInCopyId } from '../../../../shared/agent-session-availability'
import type { AgentType } from '../../../../shared/agent-status-types'
import type { NativeChatComposerImageAttachment } from './NativeChatComposerField'
import { sayAgentSessionFailureTranslated } from './agent-session-failure-words-text'
import { nativeChatImageSendBlock } from './native-chat-image-reattach'
import {
  nativeChatGateReason,
  type NativeChatGateReason
} from './native-chat-start-failure-presentation'

/** The one rule for when the host's verdict blocks Send: only a send that starts the agent. While
 *  a turn runs, Send is Stop and a follow-up queues behind it as it always has. Applied once, where
 *  the session hands the verdict to its composer, so the button, Enter, goal mode and the hidden
 *  start-failure line all read the same value. */
export function nativeChatComposerSendGate(
  unavailable: AgentSessionUnavailable | null | undefined,
  isWorking: boolean
): AgentSessionUnavailable | null {
  return isWorking ? null : (unavailable ?? null)
}

/** The session's verdict as its composer gates on it, and what that says about a start failure. */
export function nativeChatComposerVerdict(
  options: { unavailable: AgentSessionUnavailable | null; accountVerified: boolean },
  isWorking: boolean
): { unavailable: AgentSessionUnavailable | null; gated: NativeChatGateReason } {
  const unavailable = nativeChatComposerSendGate(options.unavailable, isWorking)
  return { unavailable, gated: nativeChatGateReason(unavailable, options.accountVerified) }
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
  gate: AgentSessionUnavailable | null
): { sendButtonDisabled: boolean; sendBlockedReason: string | undefined } {
  const unavailable = gate
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
