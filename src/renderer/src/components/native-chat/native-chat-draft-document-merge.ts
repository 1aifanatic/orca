import type { JSONContent } from '@tiptap/react'
import type { NativeChatComposerDraft } from './native-chat-composer-draft-storage'
import { promptTextContent } from './native-chat-prompt-document'

function inlineText(node: JSONContent): string {
  return node.type === 'text'
    ? (node.text ?? '')
    : node.type === 'hardBreak'
      ? '\n'
      : String(node.attrs?.token ?? '')
}

function documentFor(draft: NativeChatComposerDraft): JSONContent {
  const text = draft.document?.content
    ?.map((block) => block.content?.map(inlineText).join('') ?? '')
    .join('\n')
  return text === draft.text && draft.document ? draft.document : promptTextContent(draft.text)
}

/** Trim only the suffix removed by the text merge, preserving each remaining skill node. */
function trimmedContent(document: JSONContent, length: number): JSONContent[] {
  const blocks: JSONContent[] = []
  let remaining = length
  for (const block of document.content ?? []) {
    if (blocks.length > 0) {
      if (remaining === 0) {
        break
      }
      remaining -= 1
    }
    const content: JSONContent[] = []
    for (const node of block.content ?? []) {
      const text = inlineText(node)
      if (remaining === 0) {
        break
      }
      content.push(
        node.type === 'text' && text.length > remaining
          ? { ...node, text: text.slice(0, remaining) }
          : node
      )
      remaining = Math.max(0, remaining - text.length)
    }
    blocks.push({ ...block, content })
  }
  return blocks
}

/** The same text merge, with picker-created chips retained in both documents. */
export function mergeNativeChatDraftDocument(
  target: NativeChatComposerDraft,
  source: NativeChatComposerDraft,
  mergedText: string
): JSONContent | undefined {
  if (mergedText === target.text) {
    return target.document
  }
  if (mergedText === source.text) {
    return source.document
  }
  if (!target.document && !source.document) {
    return undefined
  }
  return {
    type: 'doc',
    content: [
      ...trimmedContent(documentFor(target), target.text.trimEnd().length),
      { type: 'paragraph', content: [] },
      ...(documentFor(source).content ?? [])
    ]
  }
}
