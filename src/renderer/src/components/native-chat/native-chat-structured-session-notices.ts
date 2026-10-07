import { translate } from '@/i18n/i18n'
import type { StructuredAgentSessionLaunchLifecycle } from '@/lib/structured-agent-session-launch'
import { agentSessionRefusalCauseParts } from '../../../../shared/agent-session-refusal-notice'
import type { AgentSessionWriteRefusal } from '../../../../shared/agent-session-write-failure'
import { joinSentences } from '../../../../shared/sentence-joining'
import { agentSessionWriteNoticeText } from './agent-session-write-notice-text'
import { isNativeChatSendGateFailure } from './native-chat-start-failure-presentation'
import type {
  NativeChatComposerNotice,
  NativeChatComposerNoticeContent
} from './native-chat-composer-notice'

/** A chat whose start failed or went unconfirmed, as a notice with Retry. */
function nativeChatLaunchNotice({
  lifecycle,
  failure = null,
  agentLabel,
  hasUnsentMessage = false,
  onRetry
}: {
  lifecycle: StructuredAgentSessionLaunchLifecycle | null
  /** The host's refusal behind the failed start; its message is never shown. */
  failure?: AgentSessionWriteRefusal | null
  /** Names the agent in a start failure's words. */
  agentLabel?: string
  /** A message of yours waits on this start, so its Retry stays. */
  hasUnsentMessage?: boolean
  onRetry: () => void
}): NativeChatComposerNotice | null {
  if (lifecycle !== 'failed' && lifecycle !== 'visibility-unknown') {
    return null
  }
  const parts =
    lifecycle === 'failed' && failure
      ? agentSessionRefusalCauseParts(failure, agentLabel ? { agentName: agentLabel } : {})
      : []
  // The disabled Send already says it, in the same words.
  if (
    !hasUnsentMessage &&
    parts.some(
      (part) =>
        typeof part !== 'string' && 'failure' in part && isNativeChatSendGateFailure(part.failure)
    )
  ) {
    return null
  }
  const message =
    lifecycle === 'failed'
      ? translate(
          'auto.components.native.chat.NativeChatLaunchRetry.failed',
          'Chat could not be started.'
        )
      : translate(
          'auto.components.native.chat.NativeChatLaunchRetry.unknown',
          'Chat connection could not be confirmed.'
        )
  const cause = agentSessionWriteNoticeText(parts)
  // An argument problem already says the start failed; the generic lead would repeat it.
  const saysStartFailure =
    failure?.code === 'agent_session_operation_invalid' && failure.details?.argumentProblem
  return {
    key: 'launch',
    kind: 'error',
    text: cause ? (saysStartFailure ? cause : joinSentences([message, cause])) : message,
    action: {
      label: translate('auto.components.native.chat.NativeChatLaunchRetry.retry', 'Retry'),
      onClick: onRetry
    }
  }
}

/** A structured chat's own notices, for the card above its composer. */
export function structuredSessionNotices({
  launch,
  agentLabel,
  sessionError,
  composerError
}: {
  launch: {
    lifecycle: StructuredAgentSessionLaunchLifecycle | null
    failure: AgentSessionWriteRefusal | null
    retry: () => void
    hasUnsentMessage?: boolean
  }
  agentLabel: string
  sessionError: string | null
  composerError: (NativeChatComposerNoticeContent & { onDismiss: () => void }) | null
}): NativeChatComposerNotice[] {
  const launchNotice = nativeChatLaunchNotice({
    lifecycle: launch.lifecycle,
    failure: launch.failure,
    agentLabel,
    hasUnsentMessage: launch.hasUnsentMessage,
    onRetry: launch.retry
  })
  return [
    ...(launchNotice ? [launchNotice] : []),
    ...(sessionError ? [{ key: 'session', kind: 'error' as const, text: sessionError }] : []),
    ...(composerError ? [{ key: 'composer-error', kind: 'error' as const, ...composerError }] : [])
  ]
}
