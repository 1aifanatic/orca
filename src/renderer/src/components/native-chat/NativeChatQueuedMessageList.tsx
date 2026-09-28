import { useAppStore } from '../../store'
import { translate } from '@/i18n/i18n'
import { NativeChatQueuedMessageCard } from './NativeChatQueuedMessageCard'
import type { StructuredAgentSessionQueuedMessagesController } from './use-structured-agent-session-queued-messages'

/**
 * Host-held drafts stacked between the transcript and the composer — never in
 * the transcript: a draft only becomes a bubble once the host consumes it into
 * a submission. Live region so queue changes are announced without stealing focus.
 */
export function NativeChatQueuedMessageList({
  controller
}: {
  controller: StructuredAgentSessionQueuedMessagesController
}): React.JSX.Element | null {
  const updateSettings = useAppStore((store) => store.updateSettings)
  const { cards } = controller
  if (cards.length === 0) {
    return null
  }
  const newest = cards.at(-1)
  return (
    <ul
      aria-label={translate('components.native-chat.queuedMessages.listLabel', 'Queued messages')}
      aria-live="polite"
      className="mx-auto flex w-full max-w-4xl flex-col gap-1 px-4 py-1"
    >
      {cards.map((card) => (
        <NativeChatQueuedMessageCard
          key={card.messageId}
          card={card}
          showsSteerShortcut={card === newest}
          onSteer={() => void controller.steer(card.messageId)}
          onDelete={() => void controller.remove(card.messageId)}
          onEdit={() => void controller.edit(card.messageId)}
          onTurnOffQueueing={() => void updateSettings({ nativeChatQueueFollowUps: false })}
        />
      ))}
    </ul>
  )
}
