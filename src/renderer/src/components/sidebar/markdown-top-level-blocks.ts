import type { Nodes } from 'mdast'
import { markdownBlockParser } from './markdown-block-parser'

export type MarkdownBlock = {
  /** Where the block starts in the source; it never moves as text is appended. */
  start: number
  text: string
}

export type MarkdownBlockSplit = {
  source: string
  /** In order; their text joined is the source. */
  blocks: readonly MarkdownBlock[]
  /** The document cannot be cut: something in it reaches across blocks. */
  whole: boolean
}

// A loose list can still absorb the preceding block.
const UNSETTLED_BLOCKS = 2

// Void tags cannot join later blocks.
const VOID_TAG_PATTERN = /^<(?:br|hr|wbr|img)\b[^>]*>$/i

// References and non-void HTML require the whole document for correct rendering.
function reachesAcrossBlocks(node: Nodes): boolean {
  if (node.type === 'definition' || node.type === 'footnoteDefinition') {
    return true
  }
  if (node.type === 'html') {
    return !VOID_TAG_PATTERN.test(node.value.trim())
  }
  return 'children' in node && node.children.some(reachesAcrossBlocks)
}

function wholeDocument(source: string): MarkdownBlockSplit {
  return { source, blocks: [{ start: 0, text: source }], whole: true }
}

export function splitMarkdownTopLevelBlocks(
  source: string,
  previous: MarkdownBlockSplit | null
): MarkdownBlockSplit {
  const grewFromPrevious = previous !== null && source.startsWith(previous.source)
  if (grewFromPrevious && previous.whole) {
    return wholeDocument(source)
  }
  const settled = grewFromPrevious ? previous.blocks.slice(0, -UNSETTLED_BLOCKS) : []
  const base = grewFromPrevious ? (previous.blocks.at(-UNSETTLED_BLOCKS)?.start ?? 0) : 0
  const tail = source.slice(base)
  const tree = markdownBlockParser.parse(tail)
  if (reachesAcrossBlocks(tree)) {
    return wholeDocument(source)
  }
  // Each block runs to the next one's start, so the blank lines between stay in the source.
  const starts = tree.children.map((child) =>
    'position' in child ? (child.position?.start.offset ?? 0) : 0
  )
  starts[0] = 0
  const blocks = starts.map((start, index) => ({
    start: base + start,
    text: tail.slice(start, starts[index + 1])
  }))
  return { source, blocks: [...settled, ...blocks], whole: false }
}
