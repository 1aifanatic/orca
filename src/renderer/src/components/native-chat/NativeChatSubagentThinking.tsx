import { useContext } from 'react'
import { translate } from '@/i18n/i18n'
import { NativeChatReasoningOpenContext } from './native-chat-reasoning-open-context'

/** "Thinking" beside a subagent's name while the host reports its reasoning open: the turn line's
 *  word, in the type the entry's own state text ("working") uses. */
export function NativeChatSubagentThinking({
  agentId,
  working
}: {
  agentId: string
  /** The roster says the agent works. Reasoning a host never saw end (a helper turn that never
   *  completed) must not outlive the agent. */
  working: boolean
}): React.JSX.Element | null {
  const isReasoningOpen = useContext(NativeChatReasoningOpenContext)
  if (!working || !isReasoningOpen(agentId)) {
    return null
  }
  return (
    <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
      {translate('components.native-chat.status.thinking', 'Thinking')}
    </span>
  )
}
