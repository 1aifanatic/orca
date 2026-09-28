import { useRef } from 'react'
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
  controller,
  focusComposer
}: {
  controller: StructuredAgentSessionQueuedMessagesController
  /** Where focus goes once Edit or Delete takes the focused card away. */
  focusComposer?: () => void
}): React.JSX.Element | null {
  const updateSettings = useAppStore((store) => store.updateSettings)
  const listRef = useRef<HTMLUListElement>(null)
  const { cards } = controller
  if (cards.length === 0) {
    return null
  }
  const newest = cards.at(-1)
  // Only when focus was on the card (now gone) — never pull it from wherever the user moved on to.
  const refocusAfter = (action: Promise<void>): void => {
    void action.then(() => {
      const active = document.activeElement
      if (!active || active === document.body || listRef.current?.contains(active)) {
        focusComposer?.()
      }
    })
  }
  return (
    <ul
      ref={listRef}
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
          onDelete={() => refocusAfter(controller.remove(card.messageId))}
          onEdit={() => refocusAfter(controller.edit(card.messageId))}
          onTurnOffQueueing={() => void updateSettings({ nativeChatQueueFollowUps: false })}
        />
      ))}
    </ul>
  )
}
