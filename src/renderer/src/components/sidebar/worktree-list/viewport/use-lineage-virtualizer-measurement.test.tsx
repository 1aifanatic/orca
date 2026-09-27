// @vitest-environment happy-dom
import React, { act, useLayoutEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { VirtualItem } from '@tanstack/react-virtual'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildLineageVirtualTree,
  ESTIMATED_LINEAGE_CARD_HEIGHT,
  type LineageVirtualTree
} from '../listing/lineage-virtual-tree'
import { lineageRow } from '../rows/lineage-virtualization-test-fixtures'
import { createLineageScrollAdjustment } from './lineage-scroll-adjustment'
import { useLineageVirtualizer } from './use-lineage-virtualizer'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const GROUP_KEY = 'lineage-group:all:|root'
const stubbedHeights = new Map<string, number>()
let measuredHeights: Map<string, number>
let observations: { key: string; hasPriorObservation: boolean | undefined }[]
let commits: number

function Probe({
  tree,
  mounted,
  shouldAdjustScroll,
  scrollRef
}: {
  tree: LineageVirtualTree
  mounted: ReadonlySet<string>
  shouldAdjustScroll: ReturnType<typeof createLineageScrollAdjustment>
  scrollRef: React.RefObject<HTMLDivElement | null>
}): React.JSX.Element {
  const { childrenRef, measurements } = useLineageVirtualizer({
    tree,
    scrollRef,
    measuredHeights,
    groupStart: 0,
    groupKey: GROUP_KEY,
    shouldAdjustScroll
  })
  // Reading the resolver in an effect keeps the render pure and still reports the latest sizes.
  useLayoutEffect(() => {
    commits++
    childrenRef.current?.setAttribute(
      'data-resolved',
      tree.nodes.map((node) => measurements.resolveSize(node.row.rowKey)).join(',')
    )
  })
  return (
    <div ref={childrenRef}>
      {tree.nodes
        .filter((node) => mounted.has(node.row.rowKey))
        .map((node) => (
          <div key={node.row.rowKey} data-lineage-virtual-item={node.row.rowKey} />
        ))}
    </div>
  )
}

let container: HTMLDivElement
let root: Root
let scrollRef: React.RefObject<HTMLDivElement | null>
let shouldAdjustScroll: ReturnType<typeof createLineageScrollAdjustment>
let originalRect: typeof Element.prototype.getBoundingClientRect
let originalResizeObserver: typeof globalThis.ResizeObserver

beforeEach(() => {
  stubbedHeights.clear()
  measuredHeights = new Map()
  observations = []
  commits = 0
  originalRect = Element.prototype.getBoundingClientRect
  Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
    const key = this instanceof HTMLElement ? this.dataset.lineageVirtualItem : undefined
    return new DOMRect(0, 0, 0, key === undefined ? 0 : (stubbedHeights.get(key) ?? 0))
  }
  originalResizeObserver = globalThis.ResizeObserver
  globalThis.ResizeObserver = class StubResizeObserver implements ResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }

  const scrollElement = document.createElement('div')
  scrollElement.scrollTop = 200
  document.body.append(scrollElement)
  scrollRef = { current: scrollElement }
  const group: VirtualItem = {
    key: GROUP_KEY,
    index: 0,
    start: 0,
    size: 1_000,
    end: 1_000,
    lane: 0
  }
  shouldAdjustScroll = createLineageScrollAdjustment({
    outer: {
      getVirtualItems: () => [group],
      itemSizeCache: new Map([[GROUP_KEY, group.size]])
    },
    shouldAdjustMeasuredRowScroll: (item, _instance, hasPriorObservation) => {
      observations.push({ key: String(item.key), hasPriorObservation })
      return false
    },
    hasPriorObservation: (rowKey) => measuredHeights.has(rowKey)
  })

  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  scrollRef.current?.remove()
  Element.prototype.getBoundingClientRect = originalRect
  globalThis.ResizeObserver = originalResizeObserver
})

const rowKeyOf = (id: string): string => `all:|${id}`
const KEY_B = rowKeyOf('b')

async function renderGroup(rowIds: string[], mounted: string[]): Promise<void> {
  // Depth 1 siblings: the mounted row is last, so no sibling gap joins its measured height.
  const tree = buildLineageVirtualTree(rowIds.map((id) => lineageRow(id)))
  await act(async () =>
    root.render(
      <Probe
        tree={tree}
        mounted={new Set(mounted.map(rowKeyOf))}
        shouldAdjustScroll={shouldAdjustScroll}
        scrollRef={scrollRef}
      />
    )
  )
}

const resolvedSizes = (): number[] =>
  (container.firstElementChild?.getAttribute('data-resolved') ?? '')
    .split(',')
    .filter(Boolean)
    .map(Number)

describe('lineage descendant measurement contract', () => {
  it('reports a genuinely unobserved row as a first measurement', async () => {
    stubbedHeights.set(KEY_B, 56)
    await renderGroup(['a', 'b'], ['b'])

    expect(observations).toEqual([{ key: KEY_B, hasPriorObservation: false }])
    expect(measuredHeights.get(KEY_B)).toBe(56)
    expect(resolvedSizes()).toEqual([ESTIMATED_LINEAGE_CARD_HEIGHT, 56])
  })

  it('treats growth after an observation equal to the estimate as a re-measure', async () => {
    stubbedHeights.set(KEY_B, ESTIMATED_LINEAGE_CARD_HEIGHT)
    await renderGroup(['a', 'b'], ['b'])
    expect(observations).toEqual([])
    // An observation the library never admits must still settle instead of revising every commit.
    const settled = commits
    await renderGroup(['a', 'b'], ['b'])
    expect(commits).toBe(settled + 1)

    stubbedHeights.set(KEY_B, ESTIMATED_LINEAGE_CARD_HEIGHT + 30)
    await renderGroup(['a', 'b'], ['b'])

    expect(observations).toEqual([{ key: KEY_B, hasPriorObservation: true }])
  })

  it('treats growth after a same-key transfer into this group as a re-measure', async () => {
    // The row was measured elsewhere, so this instance was never seeded with it.
    measuredHeights.set(KEY_B, 56)
    await renderGroup(['a'], [])
    stubbedHeights.set(KEY_B, 56)
    await renderGroup(['a', 'b'], ['b'])
    expect(observations).toEqual([])

    stubbedHeights.set(KEY_B, 86)
    await renderGroup(['a', 'b'], ['b'])

    expect(observations).toEqual([{ key: KEY_B, hasPriorObservation: true }])
    expect(measuredHeights.get(KEY_B)).toBe(86)
  })

  it('resizes the instance when only its own size is stale, and revises the geometry', async () => {
    measuredHeights.set(KEY_B, 56)
    stubbedHeights.set(KEY_B, 56)
    await renderGroup(['a', 'b'], ['b'])
    // The published height already matches the new observation, so only the instance is stale.
    measuredHeights.set(KEY_B, 60)
    stubbedHeights.set(KEY_B, 60)
    await renderGroup(['a', 'b'], ['b'])
    expect(resolvedSizes()).toEqual([ESTIMATED_LINEAGE_CARD_HEIGHT, 60])

    // Pruning the published height leaves the instance as the only authority.
    measuredHeights.delete(KEY_B)
    await renderGroup(['a', 'b'], [])

    expect(resolvedSizes()).toEqual([ESTIMATED_LINEAGE_CARD_HEIGHT, 60])
  })

  it('keeps reintroduced descendants at the size this group still uses after a collapse', async () => {
    const children = ['c0', 'c1', 'c2'].map(rowKeyOf)
    for (const key of [rowKeyOf('p'), ...children]) {
      measuredHeights.set(key, 56)
    }
    await renderGroup(['p', 'c0', 'c1', 'c2'], [])
    expect(resolvedSizes()).toEqual([56, 56, 56, 56])

    // The viewport prunes heights for rows that left the visible set; the group survives.
    for (const key of children) {
      measuredHeights.delete(key)
    }
    await renderGroup(['p'], [])
    expect(resolvedSizes()).toEqual([56])

    await renderGroup(['p', 'c0', 'c1', 'c2'], [])

    expect(resolvedSizes()).toEqual([56, 56, 56, 56])
  })
})
