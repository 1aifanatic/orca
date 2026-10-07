import { RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import type { StructuredAgentSessionLaunchLifecycle } from '@/lib/structured-agent-session-launch'
import { agentSessionRefusalCauseParts } from '../../../../shared/agent-session-refusal-notice'
import type { AgentSessionWriteRefusal } from '../../../../shared/agent-session-write-failure'
import { joinSentences } from '../../../../shared/sentence-joining'
import { agentSessionWriteNoticeText } from './agent-session-write-notice-text'
import { isNativeChatSendGateFailure } from './native-chat-start-failure-presentation'

export function NativeChatLaunchRetry({
  lifecycle,
  failure = null,
  agentLabel,
  hasUnsentMessage = false,
  onRetry
}: {
  lifecycle: StructuredAgentSessionLaunchLifecycle | null
  /** Names the agent in a start failure's words. */
  agentLabel?: string
  /** The host's refusal behind the failed start; its message is never shown. */
  failure?: AgentSessionWriteRefusal | null
  /** A message of yours waits on this start, so its Retry stays. */
  hasUnsentMessage?: boolean
  onRetry: () => void
}): React.JSX.Element | null {
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
  const saysStartFailure =
    failure?.code === 'agent_session_operation_invalid' && failure.details?.argumentProblem
  return (
    <div className="mx-auto flex w-full max-w-(--chat-content-max-width) items-center justify-between gap-3 px-4 py-1 text-xs text-destructive">
      <span className="min-w-0 break-words">
        {cause ? (saysStartFailure ? cause : joinSentences([message, cause])) : message}
      </span>
      <Button type="button" variant="ghost" size="xs" onClick={onRetry}>
        <RotateCcw className="size-3" />
        {translate('auto.components.native.chat.NativeChatLaunchRetry.retry', 'Retry')}
      </Button>
    </div>
  )
}
