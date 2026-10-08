import { useMemo, useState } from 'react'
import {
  splitMarkdownTopLevelBlocks,
  type MarkdownBlock,
  type MarkdownBlockSplit
} from './markdown-top-level-blocks'
import { repairStreamingMarkdownTail } from './streaming-markdown-tail'

export function useCommentMarkdownBlocks(
  content: string,
  streaming: boolean
): readonly MarkdownBlock[] {
  const [previousSplit, setPreviousSplit] = useState<MarkdownBlockSplit | null>(null)
  let split = previousSplit
  if ((streaming || previousSplit !== null) && previousSplit?.source !== content) {
    split = splitMarkdownTopLevelBlocks(content, previousSplit)
    setPreviousSplit(split)
  }
  return useMemo(() => {
    if (split === null) {
      return [{ start: 0, text: content }]
    }
    // Keep block identities when streaming ends, so code and visual controls stay mounted.
    return split.blocks.map((block, index) =>
      streaming && index === split.blocks.length - 1
        ? { ...block, text: repairStreamingMarkdownTail(block.text) }
        : block
    )
  }, [content, split, streaming])
}
