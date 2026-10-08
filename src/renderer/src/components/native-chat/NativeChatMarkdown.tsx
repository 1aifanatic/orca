import type { ComponentProps } from 'react'
import CommentMarkdown from '@/components/sidebar/CommentMarkdown'
import { cn } from '@/lib/utils'
import { withoutPendingNativeChatVisualDirectiveTail } from '../../../../shared/native-chat-visual-directive'
import { useNativeChatVisualMarkdownExtension } from './native-chat-visual-markdown-extension'
import { useNativeChatFileLinkExists } from './use-native-chat-file-link-existence'
import './native-chat-markdown.css'

type NativeChatMarkdownProps = Omit<ComponentProps<typeof CommentMarkdown>, 'fileLinkExists'> & {
  /** Underline file paths in the text that exist in the chat's workspace. */
  linkifyFilePaths?: boolean
  /** On assistant prose in a structured chat: this message may show visuals. */
  visualMessageId?: string
  /** The reply is still arriving, so an unfinished visual line at its end is held back. */
  streaming?: boolean
}

export function NativeChatMarkdown({
  className,
  linkifyFilePaths = false,
  visualMessageId,
  streaming = false,
  content,
  ...props
}: NativeChatMarkdownProps): React.JSX.Element {
  const extension = useNativeChatVisualMarkdownExtension(visualMessageId)
  const fileLinkExists = useNativeChatFileLinkExists(linkifyFilePaths, streaming)
  return (
    <CommentMarkdown
      {...props}
      content={
        extension && streaming ? withoutPendingNativeChatVisualDirectiveTail(content) : content
      }
      extension={extension}
      fileLinkExists={fileLinkExists}
      renderMermaid={!streaming}
      className={cn('native-chat-markdown', className)}
    />
  )
}
