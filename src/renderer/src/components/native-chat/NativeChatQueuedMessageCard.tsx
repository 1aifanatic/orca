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
import { classifyDispatchRejection } from '../../../../shared/structured-agent-session-dispatch-rejection'
import { readAgentSessionFailureFact } from '../../../../shared/agent-session-failure'
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
    case 'returned': {
      // Read exactly as a rejected submission: the typed fact decides, the reason is the fallback.
      const reason = card.returnedReason ?? null
      // A consumed draft whose submission a Stop withdrew is not a failure of the
      // message — say what happened rather than "not sent".
      if (
        classifyDispatchRejection({ reason, rejection: card.returnedRejection }).category ===
        'withdrawn'
      ) {
        return translate(
          'components.native-chat.queuedMessages.withdrawnHold',
          'Stopped before it was sent'
        )
      }
      return agentSessionWriteNoticeText(
        structuredAgentSessionAttemptFailureParts(
          { kind: 'rejected', reason },
          // The card's own Send is the retry, so the words leave out sending again.
          { retryControl: true },
          readAgentSessionFailureFact(card.returnedRejection)
        )
      )
    }
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

/** Steer names the mid-turn jump; a paused or returned card is not waiting on the
 *  turn anymore, so its action and tooltip are plainly Send. */
export function queuedMessageCardSendNow(card: QueuedMessageCard): {
  label: string
  hint: string
} {
  if (card.hold === 'paused' || card.hold === 'returned') {
    return {
      label: translate('components.native-chat.queuedMessages.send', 'Send'),
      hint: translate('components.native-chat.queuedMessages.sendHint', 'Send this message now')
    }
  }
  return {
    label: translate('components.native-chat.queuedMessages.steer', 'Steer'),
    hint: translate(
      'components.native-chat.queuedMessages.steerHint',
      'Send now without waiting for the turn to end'
    )
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
  const sendNow = queuedMessageCardSendNow(card)
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
            {sendNow.label}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={4}>
          {sendNow.hint}
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
