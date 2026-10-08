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

type SkillRange = { start: number; end: number; node: JSONContent }

function skillRanges(document: JSONContent, start: number): SkillRange[] {
  const ranges: SkillRange[] = []
  let offset = start
  for (const [index, block] of (document.content ?? []).entries()) {
    if (index > 0) {
      offset += 1
    }
    for (const node of block.content ?? []) {
      const end = offset + inlineText(node).length
      if (node.type === 'nativeChatSkill') {
        ranges.push({ start: offset, end, node })
      }
      offset = end
    }
  }
  return ranges
}

function carrySkills(
  node: JSONContent,
  start: number,
  ranges: readonly SkillRange[]
): JSONContent[] {
  if (node.type !== 'text') {
    return [node]
  }
  const text = node.text ?? ''
  const end = start + text.length
  const content: JSONContent[] = []
  let keptFrom = start
  for (const skill of ranges) {
    if (skill.end <= start || skill.start >= end) {
      continue
    }
    if (skill.start > keptFrom) {
      content.push({ ...node, text: text.slice(keptFrom - start, skill.start - start) })
    }
    if (skill.start >= start) {
      content.push(skill.node)
    }
    keptFrom = Math.min(end, Math.max(keptFrom, skill.end))
  }
  if (keptFrom < end) {
    content.push({ ...node, text: text.slice(keptFrom - start) })
  }
  return content
}

/** Matching literal text does not already hold a picker node; copy the explicit node. */
function deduplicatedDocument(
  target: NativeChatComposerDraft,
  source: NativeChatComposerDraft
): JSONContent | undefined {
  const start = target.text.trimEnd().length - source.text.trimEnd().length
  const ranges = skillRanges(documentFor(source), start)
  if (ranges.length === 0) {
    return target.document ?? (target.text === source.text ? source.document : undefined)
  }
  let offset = 0
  return {
    type: 'doc',
    content: (documentFor(target).content ?? []).map((block, index) => {
      if (index > 0) {
        offset += 1
      }
      return {
        ...block,
        content: (block.content ?? []).flatMap((node) => {
          const content = carrySkills(node, offset, ranges)
          offset += inlineText(node).length
          return content
        })
      }
    })
  }
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
    return deduplicatedDocument(target, source)
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
