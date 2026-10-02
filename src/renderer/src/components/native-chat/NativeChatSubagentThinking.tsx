import { useContext } from 'react'
import { translate } from '@/i18n/i18n'
import { NativeChatReasoningOpenContext } from './native-chat-reasoning-open-context'

/** "Thinking" beside a subagent's name while the host reports its reasoning open, in the words and
 *  tone the turn's own activity line uses for the same fact. */
export function NativeChatSubagentThinking({
  agentId
}: {
  agentId: string
}): React.JSX.Element | null {
  const isReasoningOpen = useContext(NativeChatReasoningOpenContext)
  if (!isReasoningOpen(agentId)) {
    return null
  }
  return (
    <span className="shrink-0 text-sm text-foreground/85">
      {translate('components.native-chat.status.thinking', 'Thinking')}
    </span>
  )
}
