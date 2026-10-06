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
        <span className="px-1">
          {translate('components.native-chat.agentMessage.unnamedSender', 'an agent')}
        </span>
      ) : null}
      {shown.map((sender) =>
        chatWorktreeId ? (
          <Button
            key={sender.party.address}
            type="button"
            variant="link"
            size="xs"
            onClick={() => void openAgentMessageSender(sender.party, chatWorktreeId)}
          >
            <span className="max-w-48 truncate">{agentMessageSenderLabel(sender)}</span>
          </Button>
        ) : (
          <span key={sender.party.address} className="max-w-48 truncate px-1">
            {agentMessageSenderLabel(sender)}
          </span>
        )
      )}
      {more > 0 ? <span>+{more}</span> : null}
    </div>
  )
}
