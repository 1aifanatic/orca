import { useId, useState } from 'react'
import {
  AlertCircle,
  ChevronDown,
  CornerDownRight,
  ListEnd,
  MoreHorizontal,
  Pencil,
  Send,
  Trash2
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { ShortcutKeyCombo } from '@/components/ShortcutKeyCombo'
import { translate } from '@/i18n/i18n'
import { structuredAgentSessionAttemptFailureParts } from '../../../../shared/structured-agent-session-send-disposition'
import { classifyDispatchRejection } from '../../../../shared/structured-agent-session-dispatch-rejection'
import { readWholeAgentSessionFailureFact } from '../../../../shared/agent-session-failure'
import { agentSessionWriteNoticeText } from './agent-session-write-notice-text'
import {
  QUEUED_MESSAGE_PAUSED_KEPT,
  QUEUED_MESSAGE_PAUSED_SEND_FAILED
} from '../../../../shared/agent-session-wire'
import { isMacPlatform } from './native-chat-shortcut'
import type { QueuedMessageCard } from './structured-agent-session-queued-cards'
import { queuedCardSenderLine } from './native-chat-agent-message-sender-label'
import { useNativeChatClippedLine } from './use-native-chat-clipped-line'

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
          readWholeAgentSessionFailureFact(card.returnedRejection)
        )
      )
    }
    case 'paused':
      // A card's own hold; the queue's pause is the list's header. Markers localize, and an absent
      // or unknown one (newer host) is a plain pause, never shown raw.
      if (card.pausedReason === QUEUED_MESSAGE_PAUSED_SEND_FAILED) {
        return translate(
          'components.native-chat.queuedMessages.pausedSendFailed',
          "Couldn't send — press Send to retry."
        )
      }
      if (card.pausedReason === QUEUED_MESSAGE_PAUSED_KEPT) {
        return translate(
          'components.native-chat.queuedMessages.pausedKept',
          'Not sent yet — press Send to send it.'
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
    case 'queue-paused':
      // Plainly queued; a paused queue's header row carries the why.
      return null
  }
}

/** Steer names the mid-turn jump, also while the whole queue is paused; a card held on its own
 *  or returned is not waiting on the turn, so its action and tooltip are plainly Send. */
export function queuedMessageCardSendNow(card: QueuedMessageCard): {
  /** Steer's ↳, or Send's paper plane. */
  steers: boolean
  label: string
  hint: string
} {
  if (card.hold === 'paused' || card.hold === 'returned') {
    return {
      steers: false,
      label: translate('components.native-chat.queuedMessages.send', 'Send'),
      hint: translate('components.native-chat.queuedMessages.sendHint', 'Send this message now')
    }
  }
  return {
    steers: true,
    label: translate('components.native-chat.queuedMessages.steer', 'Steer'),
    hint: translate(
      'components.native-chat.queuedMessages.steerHint',
      'Submit without interrupting the model'
    )
  }
}

/** Why Edit waits: the prompt card standing in the composer's slot must be answered first. */
function queuedMessageCardEditHold(editHeldBy: 'question' | 'approval' | null): string | null {
  switch (editHeldBy) {
    case 'question':
      return translate(
        'components.native-chat.queuedMessages.editHeldByQuestion',
        'Answer the question to edit'
      )
    case 'approval':
      return translate(
        'components.native-chat.queuedMessages.editHeldByApproval',
        'Answer the request to edit'
      )
    case null:
      return null
  }
}

export function NativeChatQueuedMessageCard({
  card,
  showsSteerShortcut,
  steerHeld = false,
  onSteer,
  onDelete,
  onEdit,
  editHeldBy = null,
  onTurnOffQueueing
}: {
  card: QueuedMessageCard
  /** Only the newest card answers Cmd/Ctrl+Enter; only it may show the chord. */
  showsSteerShortcut: boolean
  /** The chat reads Stopping: the card waits for the stop (`NativeChatQueuedMessageList`). */
  steerHeld?: boolean
  onSteer: () => void
  onDelete: () => void
  onEdit: () => void
  /** A prompt card stands where the composer would take Edit's text; Edit waits for the answer. */
  editHeldBy?: 'question' | 'approval' | null
  /** Absent when the host does not queue sends, so there is nothing to turn off. */
  onTurnOffQueueing?: () => void
}): React.JSX.Element {
  const caption = queuedMessageCardCaption(card)
  const returned = card.state === 'returned'
  const sendNow = queuedMessageCardSendNow(card)
  const isMac = isMacPlatform()
  // A clipped line opens in place: a card can hold text the person never typed (another agent's
  // message), and Steer or Delete must not be a blind choice.
  const [expanded, setExpanded] = useState(false)
  const [clipped, measureLine] = useNativeChatClippedLine(false)
  const textId = useId()
  const editHold = queuedMessageCardEditHold(editHeldBy)
  return (
    <li
      data-queued-message-id={card.messageId}
      data-queued-message-state={card.state}
      className={cn('flex gap-2 px-2.5 py-1.5', expanded ? 'items-start' : 'items-center')}
    >
      {returned || card.pausedReason === QUEUED_MESSAGE_PAUSED_SEND_FAILED ? (
        <AlertCircle className="size-3.5 shrink-0 text-destructive" aria-hidden />
      ) : (
        <ListEnd className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      )}
      <div className="min-w-0 flex-1">
        {card.from ? (
          <p className="truncate text-xs text-muted-foreground">
            {queuedCardSenderLine(card.from)}
          </p>
        ) : null}
        {expanded ? (
          <p
            id={textId}
            className="scrollbar-sleek max-h-60 overflow-y-auto whitespace-pre-wrap break-words text-sm"
          >
            {card.text}
          </p>
        ) : (
          <p id={textId} ref={measureLine} className="truncate text-sm" title={card.text}>
            {card.text}
          </p>
        )}
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
      {expanded || clipped ? (
        <QueuedMessageExpandToggle
          expanded={expanded}
          controls={textId}
          onToggle={() => setExpanded(!expanded)}
        />
      ) : null}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button type="button" variant="ghost" size="xs" onClick={onSteer} disabled={steerHeld}>
            {sendNow.steers ? <CornerDownRight className="size-3" /> : <Send className="size-3" />}
            {sendNow.label}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={4}>
          <span className="flex items-center gap-2">
            <span>{sendNow.hint}</span>
            {showsSteerShortcut ? (
              <ShortcutKeyCombo keys={[isMac ? '⌘' : 'Ctrl', isMac ? '⏎' : 'Enter']} />
            ) : null}
          </span>
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
          <DropdownMenuItem onSelect={onEdit} disabled={editHold !== null}>
            <Pencil />
            <span className="flex flex-col">
              {translate('components.native-chat.queuedMessages.editMessage', 'Edit message')}
              {editHold ? <span className="text-muted-foreground">{editHold}</span> : null}
            </span>
          </DropdownMenuItem>
          {onTurnOffQueueing ? (
            <DropdownMenuItem onSelect={onTurnOffQueueing}>
              {translate(
                'components.native-chat.queuedMessages.turnOffQueueing',
                'Turn off queueing'
              )}
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  )
}

function QueuedMessageExpandToggle({
  expanded,
  controls,
  onToggle
}: {
  expanded: boolean
  /** The text element it opens and folds. */
  controls: string
  onToggle: () => void
}): React.JSX.Element {
  const label = expanded
    ? translate('components.native-chat.queuedMessages.showLess', 'Show less')
    : translate('components.native-chat.queuedMessages.showFullMessage', 'Show full message')
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={label}
          aria-expanded={expanded}
          aria-controls={controls}
          onClick={onToggle}
        >
          <ChevronDown className={cn('size-3.5 transition-transform', expanded && 'rotate-180')} />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}
