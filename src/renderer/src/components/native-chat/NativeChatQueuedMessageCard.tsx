import { AlertCircle, CornerDownRight, MoreHorizontal, Pencil, Send, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ShortcutKeyCombo } from '@/components/ShortcutKeyCombo'
import { translate } from '@/i18n/i18n'
import { structuredAgentSessionAttemptFailureParts } from '../../../../shared/structured-agent-session-send-disposition'
import { DISPATCH_REJECTED_CANCELLED } from '../../../../shared/structured-agent-session-dispatch-rejection'
import { agentSessionWriteNoticeText } from './agent-session-write-notice-text'
import {
  QUEUED_MESSAGE_PAUSED_SEND_FAILED,
  QUEUED_MESSAGE_PAUSED_STOPPED
} from '../../../../shared/agent-session-wire'
import { isMacPlatform } from './native-chat-shortcut'
import type { QueuedMessageCard } from './structured-agent-session-queued-cards'

/** The visible caption under the text; the default waiting hold needs none. */
export function queuedMessageCardCaption(card: QueuedMessageCard): string | null {
  switch (card.hold) {
    case 'returned':
      // A consumed draft whose submission a Stop withdrew is not a failure of the
      // message — say what happened rather than "not sent".
      if (card.returnedReason === DISPATCH_REJECTED_CANCELLED) {
        return translate(
          'components.native-chat.queuedMessages.withdrawnHold',
          'Stopped before it was sent'
        )
      }
      // The stored effective refusal, worded exactly as a rejected submission would be.
      return agentSessionWriteNoticeText(
        structuredAgentSessionAttemptFailureParts({
          kind: 'rejected',
          reason: card.returnedReason ?? null
        })
      )
    case 'paused':
      // Markers localize; an absent or unknown one (newer host) is a plain pause, never shown raw.
      if (card.pausedReason === QUEUED_MESSAGE_PAUSED_STOPPED) {
        return translate(
          'components.native-chat.queuedMessages.pausedHold',
          'Paused — sends after your next message'
        )
      }
      if (card.pausedReason === QUEUED_MESSAGE_PAUSED_SEND_FAILED) {
        return translate(
          'components.native-chat.queuedMessages.pausedSendFailed',
          "Couldn't send — press Send to retry."
        )
      }
      return translate('components.native-chat.queuedMessages.paused', 'Paused')
    case 'behind-returned':
      return translate(
        'components.native-chat.queuedMessages.behindReturnedHold',
        'Waiting — a message ahead needs attention'
      )
    case 'awaiting-answer':
      return translate(
        'components.native-chat.queuedMessages.awaitingAnswerHold',
        'Waiting for your answer'
      )
    case 'turn':
      // The default hold; the row reads as plainly queued without a caption.
      return null
  }
}

export function NativeChatQueuedMessageCard({
  card,
  showsSteerShortcut,
  onSteer,
  onDelete,
  onEdit,
  onTurnOffQueueing
}: {
  card: QueuedMessageCard
  /** Only the newest card answers Cmd/Ctrl+Enter; only it may show the chord. */
  showsSteerShortcut: boolean
  onSteer: () => void
  onDelete: () => void
  onEdit: () => void
  onTurnOffQueueing: () => void
}): React.JSX.Element {
  const caption = queuedMessageCardCaption(card)
  const returned = card.state === 'returned'
  // Steer names the mid-turn jump; a paused or returned card is not waiting on the
  // turn anymore, so its action is plainly Send.
  const sendNowLabel =
    card.hold === 'turn' || card.hold === 'awaiting-answer' || card.hold === 'behind-returned'
      ? translate('components.native-chat.queuedMessages.steer', 'Steer')
      : translate('components.native-chat.queuedMessages.send', 'Send')
  const isMac = isMacPlatform()
  return (
    <li
      data-queued-message-id={card.messageId}
      data-queued-message-state={card.state}
      className="flex items-center gap-2 rounded-md border border-border bg-card px-2.5 py-1.5 text-card-foreground"
    >
      {returned ? (
        <AlertCircle className="size-3.5 shrink-0 text-destructive" aria-hidden />
      ) : (
        <CornerDownRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      )}
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm" title={card.text}>
          {card.text}
        </p>
        {caption ? (
          <p
            className={
              returned
                ? 'truncate text-xs text-destructive'
                : 'truncate text-xs text-muted-foreground'
            }
          >
            {caption}
          </p>
        ) : null}
      </div>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button type="button" variant="ghost" size="xs" onClick={onSteer}>
            <Send className="size-3" />
            {sendNowLabel}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={4}>
          {translate(
            'components.native-chat.queuedMessages.steerHint',
            'Send now without waiting for the turn to end'
          )}
          {showsSteerShortcut ? (
            <ShortcutKeyCombo keys={[isMac ? '⌘' : 'Ctrl', isMac ? '⏎' : 'Enter']} />
          ) : null}
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={translate('components.native-chat.queuedMessages.delete', 'Delete')}
            onClick={onDelete}
          >
            <Trash2 className="size-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={4}>
          {translate('components.native-chat.queuedMessages.delete', 'Delete')}
        </TooltipContent>
      </Tooltip>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={translate(
              'components.native-chat.queuedMessages.moreActions',
              'More actions'
            )}
          >
            <MoreHorizontal className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={onEdit}>
            <Pencil />
            {translate('components.native-chat.queuedMessages.editMessage', 'Edit message')}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onTurnOffQueueing}>
            {translate(
              'components.native-chat.queuedMessages.turnOffQueueing',
              'Turn off queueing'
            )}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  )
}
