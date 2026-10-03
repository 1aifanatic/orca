import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type RefObject
} from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { Components } from 'react-markdown'
import { translate } from '@/i18n/i18n'
import { scrollTopCache } from '@/lib/scroll-cache'
import { renderMarkdownPreviewTree } from './markdown-preview-render-tree'
import {
  getMarkdownPreviewAnchorScrollTop,
  decodeMarkdownPreviewAnchor
} from './markdown-preview-anchor-navigation'
import type { MarkdownPreviewSearchInstance } from './markdown-preview-search'
import { useMarkdownPreviewSearchReveal } from './use-markdown-preview-search-reveal'
import type {
  MarkdownPreviewDocument,
  MarkdownPreviewDocumentMatch,
  MarkdownPreviewRenderedBlock
} from './markdown-preview-document-types'
import {
  MARKDOWN_PREVIEW_OVERSCAN,
  markdownPreviewMinimumRowHeight,
  markdownPreviewViewportIndices,
  markdownPreviewRequestIndices
} from './markdown-preview-viewport-budget'
import {
  refreshMarkdownPreviewRowMeasurements,
  pruneMarkdownPreviewRowMeasurements,
  shouldAdjustMarkdownPreviewRowScroll
} from './markdown-preview-row-measurements'
import { useMarkdownPreviewBodyLayout } from './use-markdown-preview-body-layout'
import {
  markdownPreviewScrollAnchorKey,
  useMarkdownPreviewScrollAnchor
} from './use-markdown-preview-scroll-anchor'
import type { MarkdownPreviewDocumentClient } from './markdown-preview-document-client'

type PreviewReveal = { index: number } & (
  | { kind: 'anchor'; id: string }
  | { kind: 'source'; line: number }
)
export type VirtualMarkdownPreviewNavigation = {
  anchor: (id: string) => boolean
  sourceLine: (line: number) => boolean
}
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
  inert,
  revision,
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
  inert: boolean
  revision: number
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
    indicesKey: string
  } | null>(null)
  const [anchor, setAnchor] = useState<PreviewReveal | null>(null)
  const virtualBodyRef = useRef<HTMLDivElement>(null)
  const completedAnchor = useRef<PreviewReveal | null>(null)
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
  const getItemKey = useCallback(
    (index: number) => markdownPreviewScrollAnchorKey(document.blocks[index]),
    [document]
  )
  const layout = useMarkdownPreviewBodyLayout(virtualBodyRef, rootRef)
  const minimumRowHeight = markdownPreviewMinimumRowHeight(layout.height)
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: document.blocks.length,
    getScrollElement: () => rootRef.current,
    estimateSize: (index) => Math.max(minimumRowHeight, document.blocks[index].estimate),
    getItemKey,
    initialOffset: () => scrollTopCache.get(scrollCacheKey) ?? 0,
    scrollMargin: layout.margin,
    overscan: MARKDOWN_PREVIEW_OVERSCAN,
    rangeExtractor: (range) => markdownPreviewViewportIndices(range, pinnedAnnotationIndex)
  })
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = shouldAdjustMarkdownPreviewRowScroll
  useLayoutEffect(() => {
    pruneMarkdownPreviewRowMeasurements(virtualizer)
  }, [document, virtualizer])
  const measuredMinimumHeight = useRef(minimumRowHeight)
  useLayoutEffect(() => {
    refreshMarkdownPreviewRowMeasurements(
      virtualizer,
      virtualBodyRef.current,
      measuredMinimumHeight.current !== minimumRowHeight
    )
    measuredMinimumHeight.current = minimumRowHeight
  }, [minimumRowHeight, rendered, virtualizer])
  useMarkdownPreviewScrollAnchor({
    blocks: document.blocks,
    rootRef,
    virtualizer,
    scrollCacheKey,
    revision
  })
  const anchorBlocks = useMemo(
    () =>
      new Map(
        document.blocks.flatMap((block) => block.anchors.map((id) => [id, block.index] as const))
      ),
    [document]
  )
  const rows = virtualizer.getVirtualItems()
  const indicesKey = markdownPreviewRequestIndices(
    rows.map((row) => row.index),
    [activeMatch?.block ?? -1, anchor?.index ?? -1, pinnedAnnotationIndex]
  ).join(',')
  useEffect(() => {
    let current = true
    const indices = indicesKey ? indicesKey.split(',').map(Number) : []
    void client
      .request({ type: 'blocks', indices })
      .then((response) => {
        if (current && response.type === 'blocks') {
          setRendered({ client, blocks: response.blocks, indicesKey })
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
        setAnchor({ kind: 'anchor', id, index })
        return true
      },
      sourceLine: (line) => {
        const index = document.blocks.findIndex(
          (block) =>
            block.sourceLine !== null &&
            block.sourceLine <= line &&
            (block.sourceEndLine ?? block.sourceLine) >= line
        )
        if (index === -1) {
          return false
        }
        virtualizer.scrollToIndex(index, { align: 'center' })
        setAnchor({ kind: 'source', line, index })
        return true
      }
    }),
    [anchorBlocks, document, virtualizer]
  )
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
      (anchor.kind === 'anchor'
        ? [...block.querySelectorAll<HTMLElement>('[id]')].find((node) => node.id === anchor.id)
        : [...block.querySelectorAll<HTMLElement>('[data-source-line][data-source-end-line]')].find(
            (node) =>
              Number(node.dataset.sourceLine) <= anchor.line &&
              Number(node.dataset.sourceEndLine) >= anchor.line
          )) ?? block
    container.scrollTo({ top: getMarkdownPreviewAnchorScrollTop(container, target) })
    target.focus({ preventScroll: true })
    completedAnchor.current = anchor
  }, [anchor, bodyRef, client, rendered, rootRef])
  useMarkdownPreviewSearchReveal({
    client,
    query,
    activeMatch,
    blocks: rendered?.client === client ? rendered.blocks : null,
    viewportReady: rendered?.client === client && rendered.indicesKey === indicesKey,
    rootRef,
    bodyRef,
    virtualizer,
    searchInstance
  })
  const available = new Map(
    rendered?.client === client ? rendered.blocks.map((block) => [block.index, block] as const) : []
  )
  return (
    <div
      ref={virtualBodyRef}
      inert={inert || undefined}
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
            data-preview-block-key={markdownPreviewScrollAnchorKey(document.blocks[row.index])}
            data-preview-block-loaded={block ? true : undefined}
            ref={block ? virtualizer.measureElement : undefined}
            className="absolute left-0 top-0 w-full flow-root"
            style={{
              transform: `translateY(${row.start - virtualizer.options.scrollMargin}px)`,
              minHeight: block ? minimumRowHeight : Math.max(minimumRowHeight, row.size)
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
