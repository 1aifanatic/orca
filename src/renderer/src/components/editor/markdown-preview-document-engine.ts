import type { Root } from 'hast'
import { yieldToEventLoop } from '../../../../shared/event-loop-yield'
import { isClipboardTextByteLengthOverLimit } from '../../../../shared/clipboard-text'
import {
  findTextMatchRanges,
  isMarkdownPreviewSearchQueryTooLarge
} from './markdown-preview-search'
import {
  countMarkdownPreviewNodes,
  parseMarkdownPreviewDocument,
  renderMarkdownPreviewBlock
} from './markdown-preview-document-tree'
import {
  LARGE_MARKDOWN_PREVIEW_MAX_BYTES,
  MARKDOWN_PREVIEW_VIEWPORT_MAX_NODES,
  MARKDOWN_PREVIEW_MAX_REQUESTED_BLOCKS,
  MARKDOWN_PREVIEW_MAX_SEARCH_MATCHES,
  type MarkdownPreviewRenderedBlock,
  type MarkdownPreviewDocumentMatch
} from './markdown-preview-document-types'

function collectTextNodes(node: Root | Root['children'][number], values: string[]): void {
  if (
    node.type === 'element' &&
    (node.tagName === 'math' ||
      node.tagName === 'svg' ||
      (node.tagName === 'code' &&
        node.properties.className?.toString().includes('language-mermaid')))
  ) {
    return
  }
  if (node.type === 'text') {
    if (node.value.trim()) {
      values.push(node.value)
    }
  } else if ('children' in node) {
    for (const child of node.children) {
      collectTextNodes(child, values)
    }
  }
}

export class MarkdownPreviewDocumentEngine {
  private tree: Root | null = null
  private readonly cache = new Map<number, MarkdownPreviewRenderedBlock>()
  private searchRevision = 0

  load(content: string) {
    this.searchRevision += 1
    this.tree = null
    this.cache.clear()
    if (isClipboardTextByteLengthOverLimit(content, LARGE_MARKDOWN_PREVIEW_MAX_BYTES)) {
      throw new Error('Document exceeds the preview size limit.')
    }
    const { tree, document } = parseMarkdownPreviewDocument(content)
    this.tree = tree
    this.cache.clear()
    return document
  }

  private render(index: number): MarkdownPreviewRenderedBlock {
    const existing = this.cache.get(index)
    if (existing) {
      this.cache.delete(index)
      this.cache.set(index, existing)
      return existing
    }
    const node = this.tree?.children[index]
    if (!node) {
      throw new Error('Invalid preview block.')
    }
    const block = renderMarkdownPreviewBlock(node, index)
    if (block.oversized) {
      block.tree = { type: 'root', children: [] }
    }
    this.cache.set(index, block)
    while (this.cache.size > 64) {
      const oldest = this.cache.keys().next().value
      if (oldest !== undefined) {
        this.cache.delete(oldest)
      }
    }
    return block
  }

  blocks(indices: number[]): MarkdownPreviewRenderedBlock[] {
    if (
      indices.length > MARKDOWN_PREVIEW_MAX_REQUESTED_BLOCKS ||
      indices.some(
        (index) =>
          !Number.isInteger(index) || index < 0 || index >= (this.tree?.children.length ?? 0)
      )
    ) {
      throw new Error('Invalid preview viewport.')
    }
    let remaining = MARKDOWN_PREVIEW_VIEWPORT_MAX_NODES
    return [...new Set(indices)].map((index) => {
      const block = this.render(index)
      const count = countMarkdownPreviewNodes(block.tree, remaining)
      if (count > remaining) {
        return { index, tree: { type: 'root' as const, children: [] }, oversized: true }
      }
      remaining -= count
      return block
    })
  }

  async search(
    query: string
  ): Promise<{ matches: MarkdownPreviewDocumentMatch[]; truncated: boolean } | null> {
    const revision = ++this.searchRevision
    const matches: MarkdownPreviewDocumentMatch[] = []
    if (!query || isMarkdownPreviewSearchQueryTooLarge(query)) {
      return { matches, truncated: false }
    }
    for (let blockIndex = 0; blockIndex < (this.tree?.children.length ?? 0); blockIndex += 1) {
      if (revision !== this.searchRevision) {
        return null
      }
      const rendered = this.render(blockIndex)
      const values: string[] = []
      collectTextNodes(rendered.tree, values)
      let occurrence = 0
      for (const value of values) {
        for (const _range of findTextMatchRanges(value, query)) {
          if (matches.length >= MARKDOWN_PREVIEW_MAX_SEARCH_MATCHES) {
            return { matches, truncated: true }
          }
          matches.push({ block: blockIndex, occurrence: occurrence++ })
        }
      }
      if (blockIndex % 16 === 15) {
        await yieldToEventLoop()
      }
    }
    return revision === this.searchRevision ? { matches, truncated: false } : null
  }
}
