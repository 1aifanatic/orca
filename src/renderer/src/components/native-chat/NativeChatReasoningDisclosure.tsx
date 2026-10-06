import { ChevronRight } from 'lucide-react'
import CommentMarkdown, {
  type CommentMarkdownLinkClickHandler
} from '@/components/sidebar/CommentMarkdown'
import { NativeChatCodeBlock } from './NativeChatCodeBlock'

/** A reasoning block's text, under the live activity line or its finished row. Capped and
 *  scrollable, so an expanded block streaming at the tail cannot grow without bound. */
export function NativeChatReasoningBody({
  markdown,
  onLinkClick,
  allowFileUriLinks
}: {
  markdown: string
  onLinkClick?: CommentMarkdownLinkClickHandler
  allowFileUriLinks?: boolean
}): React.JSX.Element {
  return (
    <div className="scrollbar-sleek mt-1 max-h-80 overflow-y-auto pl-5.5 italic">
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
  )
}

/** The disclosure caret of a `group/reasoning` header: shown on hover, keyboard focus (on the
 *  header or a trigger inside it) and touch, and turned while open. */
export function NativeChatReasoningChevron(): React.JSX.Element {
  return (
    <ChevronRight
      aria-hidden
      className="size-3.5 shrink-0 transition-all can-hover:opacity-0 group-hover/reasoning:opacity-100 group-focus-visible/reasoning:opacity-100 group-has-[:focus-visible]/reasoning:opacity-100 group-data-[state=open]/reasoning:rotate-90 group-data-[state=open]/reasoning:opacity-100 motion-reduce:transition-none"
    />
  )
}
