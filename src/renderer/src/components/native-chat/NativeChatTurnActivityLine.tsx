import { Loader2 } from 'lucide-react'
import type { CommentMarkdownLinkClickHandler } from '@/components/sidebar/CommentMarkdown'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { translate } from '@/i18n/i18n'
import type { NativeChatTurnActivity } from '../../../../shared/native-chat-turn-activity'
import { describeNativeChatActiveTurnLabel } from '../../../../shared/native-chat-turn-status'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { deriveNativeChatRowContent } from '../../../../shared/native-chat-row-content'
import { nativeChatReasoningDisclosureKey } from '../../../../shared/native-chat-reasoning-row'
import {
  NativeChatReasoningBody,
  NativeChatReasoningChevron
} from './NativeChatReasoningDisclosure'
import { useNativeChatDisclosure } from './native-chat-disclosure-store'

/** The live turn's tail line: a spinner plus what the turn is doing right now —
 *  the provider's activity text, else that it is reasoning, else plain "Working…".
 *  The clock lives in the turn bar under the user's message, not here. While the
 *  agent's open reasoning block has text, the line is that block's disclosure. */
export function NativeChatTurnActivityLine({
  activity,
  thinking,
  liveReasoning = null,
  onLinkClick,
  allowFileUriLinks
}: {
  activity?: NativeChatTurnActivity | null
  thinking: boolean
  /** The open block this line discloses; its row draws nothing meanwhile. */
  liveReasoning?: NativeChatMessage | null
  onLinkClick?: CommentMarkdownLinkClickHandler
  allowFileUriLinks?: boolean
}): React.JSX.Element {
  const resolved = describeNativeChatActiveTurnLabel({ activityText: activity?.text, thinking })
  const label =
    resolved.source === 'activity'
      ? resolved.text
      : resolved.key === 'thinking'
        ? translate('components.native-chat.status.thinking', 'Thinking')
        : translate('components.native-chat.status.working', 'Working…')

  if (liveReasoning) {
    return (
      <NativeChatTurnActivityDisclosure
        label={label}
        reasoning={liveReasoning}
        onLinkClick={onLinkClick}
        allowFileUriLinks={allowFileUriLinks}
      />
    )
  }
  return (
    <div
      className="flex min-h-6 items-center gap-1.5 text-sm leading-relaxed text-muted-foreground"
      data-native-chat-turn-activity="true"
      aria-live="polite"
      aria-atomic="true"
    >
      <Loader2 aria-hidden className="size-4 shrink-0 animate-spin motion-reduce:animate-none" />
      <span className="min-w-0 flex-1 truncate text-foreground/85">{label}</span>
    </div>
  )
}

function NativeChatTurnActivityDisclosure({
  label,
  reasoning,
  onLinkClick,
  allowFileUriLinks
}: {
  label: string
  reasoning: NativeChatMessage
  onLinkClick?: CommentMarkdownLinkClickHandler
  allowFileUriLinks?: boolean
}): React.JSX.Element {
  // The finished row reads this key too, so a block opened here lands open once it ends.
  const disclosure = useNativeChatDisclosure(nativeChatReasoningDisclosureKey(reasoning.id), false)
  return (
    <div className="min-w-0 text-sm text-muted-foreground" data-native-chat-turn-activity="true">
      <Collapsible open={disclosure.open} onOpenChange={disclosure.setOpen}>
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="group/reasoning flex min-h-6 w-full min-w-0 items-center gap-1.5 rounded-md text-left leading-relaxed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
          >
            <Loader2
              aria-hidden
              className="size-4 shrink-0 animate-spin motion-reduce:animate-none"
            />
            {/* Only the label is live: the streaming body would be re-announced on every frame. */}
            <span
              aria-live="polite"
              aria-atomic="true"
              className="min-w-0 truncate text-foreground/85"
            >
              {label}
            </span>
            <NativeChatReasoningChevron />
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <NativeChatReasoningBody
            markdown={deriveNativeChatRowContent(reasoning.blocks).markdown}
            onLinkClick={onLinkClick}
            allowFileUriLinks={allowFileUriLinks}
          />
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}
