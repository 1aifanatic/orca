import { useCallback, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react'
import type React from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { LineageScrollAdjustment } from './lineage-scroll-adjustment'
import { getInitialLineageMeasurements } from './lineage-measurement-cache'
import { scrollLineageVirtualizer } from './lineage-scroll-to'
import {
  createLineageRowSizeResolver,
  ESTIMATED_LINEAGE_CARD_HEIGHT,
  LINEAGE_SIBLING_GAP,
  LINEAGE_VIRTUAL_OVERSCAN,
  type LineageVirtualTree
} from '../listing/lineage-virtual-tree'

export function useLineageVirtualizer(args: {
  tree: LineageVirtualTree
  scrollRef: React.RefObject<HTMLDivElement | null>
  measuredHeights: Map<string, number>
  groupStart: number
  groupKey: string
  shouldAdjustScroll: LineageScrollAdjustment
}) {
  const { tree, scrollRef, measuredHeights, groupStart } = args
  const childrenRef = useRef<HTMLDivElement>(null)
  const [scrollMargin, setScrollMargin] = useState(groupStart)
  // Restored heights must also restore measured status for the fold adjustment policy.
  const [initialMeasurementsCache] = useState(() =>
    getInitialLineageMeasurements(tree, measuredHeights, groupStart)
  )
  const [measurementRevision, measurementsChanged] = useReducer(
    (revision: number) => revision + 1,
    0
  )
  const getItemKey = useCallback((index: number) => tree.nodes[index]!.row.rowKey, [tree])
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: tree.nodes.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) =>
      measuredHeights.get(tree.nodes[index]!.row.rowKey) ?? ESTIMATED_LINEAGE_CARD_HEIGHT,
    getItemKey,
    scrollMargin,
    // Mounting an offscreen group must not reset the shared scroller to zero.
    initialOffset: () => scrollRef.current?.scrollTop ?? 0,
    initialMeasurementsCache,
    scrollToFn: scrollLineageVirtualizer,
    overscan: LINEAGE_VIRTUAL_OVERSCAN,
    useFlushSync: false
  })
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, delta, instance) =>
    args.shouldAdjustScroll(args.groupKey, item, delta, instance)
  // The revision covers both authorities: the instance can resize when the shared map does not.
  const measurements = useMemo(
    () => ({
      resolveSize: createLineageRowSizeResolver(measuredHeights, virtualizer.itemSizeCache),
      revision: measurementRevision
    }),
    [measuredHeights, measurementRevision, virtualizer]
  )

  const measureRows = useCallback(() => {
    const container = childrenRef.current
    const scrollElement = scrollRef.current
    if (!container || !scrollElement) {
      return
    }
    const margin =
      container.getBoundingClientRect().top -
      scrollElement.getBoundingClientRect().top +
      scrollElement.scrollTop -
      scrollElement.clientTop
    setScrollMargin((previous) => (previous === margin ? previous : margin))
    let changed = false
    for (const element of container.querySelectorAll<HTMLElement>('[data-lineage-virtual-item]')) {
      const index = tree.indexByRowKey.get(element.dataset.lineageVirtualItem ?? '')
      const node = index === undefined ? undefined : tree.nodes[index]
      if (!node || index === undefined) {
        continue
      }
      const descendants = element.querySelector<HTMLElement>('[data-lineage-virtual-children]')
      const fullHeight = element.getBoundingClientRect().height
      if (fullHeight <= 0) {
        continue
      }
      const height =
        fullHeight -
        (descendants?.getBoundingClientRect().height ?? 0) +
        (node.followingSibling ? LINEAGE_SIBLING_GAP : 0)
      const publishedSize = measuredHeights.get(node.row.rowKey)
      // The size this row occupies now, read the way resizeItem reads it, so a no-op cannot notify.
      const occupiedSize =
        virtualizer.itemSizeCache.get(node.row.rowKey) ??
        virtualizer.measurementsCache[index]?.size ??
        publishedSize ??
        ESTIMATED_LINEAGE_CARD_HEIGHT
      if (height <= 0 || (occupiedSize === height && publishedSize === height)) {
        continue
      }
      if (occupiedSize !== height) {
        // Resize before publishing, so the fold policy still reads this row's prior observation.
        virtualizer.resizeItem(index, height)
      }
      measuredHeights.set(node.row.rowKey, height)
      changed = true
    }
    if (changed) {
      measurementsChanged()
    }
  }, [measuredHeights, scrollRef, tree, virtualizer])

  const virtualItems = virtualizer.getVirtualItems()
  // Reveal and interaction retention can mount rows without changing the virtual range.
  useLayoutEffect(measureRows)
  useLayoutEffect(() => {
    const container = childrenRef.current
    if (!container) {
      return
    }
    const observer = new ResizeObserver(measureRows)
    observer.observe(container)
    for (const element of container.querySelectorAll('[data-lineage-virtual-item]')) {
      observer.observe(element)
    }
    return () => observer.disconnect()
  })

  return { childrenRef, virtualItems, measurements }
}
