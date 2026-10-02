import {
  memo,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type RefObject
} from 'react'
import { defaultRangeExtractor, useVirtualizer } from '@tanstack/react-virtual'
import type { Components } from 'react-markdown'
import { translate } from '@/i18n/i18n'
import { scrollTopCache } from '@/lib/scroll-cache'
import { renderMarkdownPreviewTree } from './markdown-preview-render-tree'
import {
  getMarkdownPreviewAnchorScrollTop,
  decodeMarkdownPreviewAnchor
} from './markdown-preview-anchor-navigation'
import {
  applyMarkdownPreviewSearchHighlights,
  clearMarkdownPreviewSearchHighlights,
  setActiveMarkdownPreviewSearchMatch,
  type MarkdownPreviewSearchInstance
} from './markdown-preview-search'
import {
  MARKDOWN_PREVIEW_MAX_REQUESTED_BLOCKS,
  type MarkdownPreviewDocument,
  type MarkdownPreviewDocumentMatch,
  type MarkdownPreviewRenderedBlock
} from './markdown-preview-document-types'
import { useMarkdownPreviewScrollAnchor } from './use-markdown-preview-scroll-anchor'
import type { MarkdownPreviewDocumentClient } from './markdown-preview-document-client'

export type VirtualMarkdownPreviewNavigation = { anchor: (id: string) => boolean }
const RenderedBlock = memo(function RenderedBlock({
  block,
  components
}: {
  block: MarkdownPreviewRenderedBlock
  components: Components
}) {
  return <>{renderMarkdownPreviewTree(block.tree, components)}</>
})

export function VirtualMarkdownPreviewBody({
  document,
  client,
  components,
  rootRef,
  bodyRef,
  navigationRef,
  query,
  matches,
  activeMatchIndex,
  searchInstance,
  scrollCacheKey,
  activeAnnotationBlockKey
}: {
  document: MarkdownPreviewDocument
  client: MarkdownPreviewDocumentClient
  components: Components
  rootRef: RefObject<HTMLDivElement | null>
  bodyRef: RefObject<HTMLDivElement | null>
  navigationRef: RefObject<VirtualMarkdownPreviewNavigation | null>
  query: string
  matches: MarkdownPreviewDocumentMatch[]
  activeMatchIndex: number
  searchInstance: MarkdownPreviewSearchInstance
  scrollCacheKey: string
  activeAnnotationBlockKey: string | null
}) {
  const [rendered, setRendered] = useState<{
    client: MarkdownPreviewDocumentClient
    blocks: MarkdownPreviewRenderedBlock[]
  } | null>(null)
  const [anchor, setAnchor] = useState<{ id: string; index: number } | null>(null)
  const virtualBodyRef = useRef<HTMLDivElement>(null)
  const pendingHighlight = useRef<Range[]>([])
  const completedAnchor = useRef<{ id: string; index: number } | null>(null)
  const activeMatch = matches[activeMatchIndex]
  const annotationLine = Number(activeAnnotationBlockKey?.split(':')[1]?.split('-')[0])
  const pinnedAnnotationIndex = Number.isInteger(annotationLine)
    ? document.blocks.findIndex(
        (block) =>
          block.sourceLine !== null &&
          block.sourceLine <= annotationLine &&
          (block.sourceEndLine ?? block.sourceLine) >= annotationLine
      )
    : -1
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: document.blocks.length,
    getScrollElement: () => rootRef.current,
    estimateSize: (index) => document.blocks[index].estimate,
    getItemKey: (index) => index,
    initialOffset: () => scrollTopCache.get(scrollCacheKey) ?? 0,
    scrollMargin: virtualBodyRef.current?.offsetTop ?? 0,
    overscan: 3,
    rangeExtractor: (range) => {
      const indices = defaultRangeExtractor(range)
      if (pinnedAnnotationIndex >= 0 && !indices.includes(pinnedAnnotationIndex)) {
        indices.push(pinnedAnnotationIndex)
      }
      return indices.sort((a, b) => a - b).slice(0, MARKDOWN_PREVIEW_MAX_REQUESTED_BLOCKS)
    }
  })
  useMarkdownPreviewScrollAnchor({ blocks: document.blocks, rootRef, virtualizer, scrollCacheKey })
  const anchorBlocks = useMemo(
    () =>
      new Map(
        document.blocks.flatMap((block) => block.anchors.map((id) => [id, block.index] as const))
      ),
    [document]
  )
  const rows = virtualizer.getVirtualItems()
  const indicesKey = rows.map((row) => row.index).join(',')
  useEffect(() => {
    let current = true
    const indices = indicesKey ? indicesKey.split(',').map(Number) : []
    void client
      .request({ type: 'blocks', indices })
      .then((response) => {
        if (current && response.type === 'blocks') {
          setRendered({ client, blocks: response.blocks })
        }
      })
      .catch(() => {})
    return () => {
      current = false
      client.cancel('blocks')
    }
  }, [client, indicesKey])
  useImperativeHandle(
    navigationRef,
    () => ({
      anchor: (rawId) => {
        const id = decodeMarkdownPreviewAnchor(rawId)
        const index = anchorBlocks.get(id)
        if (index === undefined) {
          return false
        }
        virtualizer.scrollToIndex(index, { align: 'start' })
        setAnchor({ id, index })
        return true
      }
    }),
    [anchorBlocks, virtualizer]
  )
  useEffect(() => {
    if (activeMatch) {
      virtualizer.scrollToIndex(activeMatch.block, { align: 'center' })
    }
  }, [activeMatch, virtualizer])
  useEffect(() => {
    const body = bodyRef.current
    const container = rootRef.current
    if (
      !anchor ||
      completedAnchor.current === anchor ||
      !body ||
      !container ||
      rendered?.client !== client
    ) {
      return
    }
    const block = body.querySelector<HTMLElement>(`[data-preview-block-index="${anchor.index}"]`)
    if (!block || !rendered.blocks.some((entry) => entry.index === anchor.index)) {
      return
    }
    const target =
      [...block.querySelectorAll<HTMLElement>('[id]')].find((node) => node.id === anchor.id) ??
      block
    container.scrollTo({ top: getMarkdownPreviewAnchorScrollTop(container, target) })
    target.focus({ preventScroll: true })
    completedAnchor.current = anchor
  }, [anchor, bodyRef, client, rendered, rootRef])
  useEffect(() => {
    const body = bodyRef.current
    if (!body || rendered?.client !== client) {
      return
    }
    const block = activeMatch
      ? body.querySelector<HTMLElement>(`[data-preview-block-index="${activeMatch.block}"]`)
      : null
    clearMarkdownPreviewSearchHighlights(searchInstance)
    pendingHighlight.current = block
      ? applyMarkdownPreviewSearchHighlights(searchInstance, block, query)
      : []
    setActiveMarkdownPreviewSearchMatch(
      searchInstance,
      pendingHighlight.current,
      activeMatch?.occurrence ?? -1
    )
    return () => {
      pendingHighlight.current = []
      clearMarkdownPreviewSearchHighlights(searchInstance)
    }
  }, [activeMatch, bodyRef, client, query, rendered, searchInstance])
  const available = new Map(
    rendered?.client === client ? rendered.blocks.map((block) => [block.index, block] as const) : []
  )
  return (
    <div
      ref={virtualBodyRef}
      className="relative w-full"
      style={{ height: virtualizer.getTotalSize() }}
      data-markdown-virtual-preview="true"
    >
      {rows.map((row) => {
        const block = available.get(row.index)
        return (
          <div
            key={row.key}
            data-index={row.index}
            data-preview-block-index={row.index}
            ref={virtualizer.measureElement}
            className="absolute left-0 top-0 w-full flow-root"
            style={{
              transform: `translateY(${row.start - virtualizer.options.scrollMargin}px)`,
              minHeight: block ? undefined : row.size
            }}
          >
            {block?.oversized ? (
              <p className="text-sm text-muted-foreground">
                {translate(
                  'editor.markdownPreview.blockTooLarge',
                  'This block is too large to render. Open source view to read it.'
                )}
              </p>
            ) : block ? (
              <RenderedBlock block={block} components={components} />
            ) : null}
          </div>
        )
      })}
    </div>
  )
}
