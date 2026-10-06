import { translate } from '@/i18n/i18n'
import {
  agentMessageSendersShown,
  type AgentMessageSender,
  type AgentMessageSource
} from '../../../../shared/agent-session-message-source'

function unnamedSenderLabel(): string {
  return translate('components.native-chat.agentMessage.unnamedSender', 'an agent')
}

export function agentMessageSenderLabel(sender: AgentMessageSender): string {
  return sender.name ?? unnamedSenderLabel()
}

/** A queued card's plain "From <names>" line; the card's own controls own its clicks. */
export function queuedCardSenderLine(from: AgentMessageSource): string {
  const { shown, more } = agentMessageSendersShown(from)
  const names = [...new Set(shown.map(agentMessageSenderLabel))]
  const listed = names.length > 0 ? names.join(', ') : unnamedSenderLabel()
  return translate('components.native-chat.queuedMessages.from', 'From {{names}}', {
    names: more > 0 ? `${listed} +${more}` : listed
  })
}
