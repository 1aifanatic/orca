import { ChevronRight } from 'lucide-react'
import CommentMarkdown, {
  type CommentMarkdownLinkClickHandler
} from '@/components/sidebar/CommentMarkdown'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { translate } from '@/i18n/i18n'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { formatNativeChatDuration } from '../../../../shared/native-chat-turn-status'
import { isNativeChatReasoningUnderway } from '../../../../shared/native-chat-live-reasoning'
import { NativeChatCodeBlock } from './NativeChatCodeBlock'

/** What the row's own lifecycle says, read from host facts only: the row's start (`timestamp`)
 *  and the end the host saw. A row with no lifecycle came from a host that kept none. */
function reasoningHeadline(
  message: Pick<NativeChatMessage, 'state' | 'completedAt' | 'timestamp'>
): string {
  if (message.state === undefined) {
    return translate('components.native-chat.reasoning', 'Reasoning')
  }
  // An open row in a turn that is no longer live ended unseen, so it claims no duration.
  if (
    message.state !== 'completed' ||
    message.completedAt === undefined ||
    message.timestamp === null
  ) {
    return translate('components.native-chat.thought', 'Thought')
  }
  return translate('components.native-chat.thoughtForDuration', 'Thought for {{duration}}', {
    duration: formatNativeChatDuration(
      Math.max(1, (message.completedAt - message.timestamp) / 1000)
    )
  })
}

export function NativeChatReasoningRow({
  message,
  markdown,
  turnIsWorking = false,
  onLinkClick,
  allowFileUriLinks
}: {
  message: Pick<NativeChatMessage, 'role' | 'state' | 'completedAt' | 'timestamp'>
  markdown: string
  /** The row's own turn is still running; a row is live only inside one. */
  turnIsWorking?: boolean
  onLinkClick?: CommentMarkdownLinkClickHandler
  allowFileUriLinks?: boolean
}): React.JSX.Element | null {
  if (!markdown.trim() || isNativeChatReasoningUnderway(message, turnIsWorking)) {
    return null
  }
  const label = translate('components.native-chat.reasoning', 'Reasoning')
  const headline = reasoningHeadline(message)

  return (
    <div className="min-w-0 text-sm text-muted-foreground">
      <Collapsible>
        <CollapsibleTrigger asChild>
          <Button variant="ghost" size="xs" className="group w-full min-w-0 justify-start">
            {headline === label ? null : <span className="sr-only">{label}: </span>}
            <span className="min-w-0 truncate">{headline}</span>
            <ChevronRight
              aria-hidden
              className="ml-auto size-3.5 shrink-0 transition-transform group-data-[state=open]:rotate-90 motion-reduce:transition-none"
            />
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="mt-1 pl-4 italic">
            <CommentMarkdown
              content={markdown}
              variant="document"
              className="text-sm"
              renderCodeBlock={NativeChatCodeBlock}
              onLinkClick={onLinkClick}
              allowFileUriLinks={allowFileUriLinks}
              linkifyFilePaths={onLinkClick !== undefined}
            />
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}
