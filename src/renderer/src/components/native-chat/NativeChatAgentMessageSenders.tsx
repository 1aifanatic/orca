import { Fragment } from 'react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { openAgentMessageSender } from '@/lib/open-agent-message-sender'
import {
  agentMessageSendersShown,
  type AgentMessageSource
} from '../../../../shared/agent-session-message-source'
import { agentMessageSenderLabel } from './native-chat-agent-message-sender-label'

/** "Message from <name>" over another agent's message; each name opens that agent. Plain text
 *  where the transcript has no chat to resolve the sender against. */
export function NativeChatAgentMessageSenders({
  from,
  chatWorktreeId
}: {
  from: AgentMessageSource
  chatWorktreeId: string | null
}): React.JSX.Element {
  const { shown, more } = agentMessageSendersShown(from)
  return (
    <div className="flex min-w-0 max-w-full flex-wrap items-center text-xs text-muted-foreground">
      <span>{translate('components.native-chat.agentMessage.messageFrom', 'Message from')}</span>
      {shown.length === 0 ? (
        <span className="px-2">
          {translate('components.native-chat.agentMessage.unnamedSender', 'an agent')}
        </span>
      ) : null}
      {shown.map((sender, index) => (
        // Fragment keys: one sender's name and the separator after it.
        <Fragment key={sender.party.address}>
          {chatWorktreeId ? (
            <Button
              type="button"
              variant="link"
              size="xs"
              onClick={() => void openAgentMessageSender(from, sender, chatWorktreeId)}
            >
              <span className="max-w-48 truncate">{agentMessageSenderLabel(sender)}</span>
            </Button>
          ) : (
            <span className="max-w-48 truncate px-2">{agentMessageSenderLabel(sender)}</span>
          )}
          {/* Pulled back over the name's padding, so it reads "A, B" as the queued card does. */}
          {index < shown.length - 1 ? (
            <span aria-hidden className="-ml-2">
              ,
            </span>
          ) : null}
        </Fragment>
      ))}
      {more > 0 ? <span>+{more}</span> : null}
    </div>
  )
}
