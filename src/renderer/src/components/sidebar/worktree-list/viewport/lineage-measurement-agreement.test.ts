import { Virtualizer, type VirtualizerOptions } from '@tanstack/react-virtual'
import { describe, expect, it, vi } from 'vitest'
import {
  buildLineageVirtualTree,
  createLineageRowSizeResolver,
  ESTIMATED_LINEAGE_CARD_HEIGHT,
  LINEAGE_VIRTUAL_OVERSCAN,
  getLineageVirtualChildSpans,
  getLineageVirtualOffsets,
  type LineageVirtualTree
} from '../listing/lineage-virtual-tree'
import { lineageRow } from '../rows/lineage-virtualization-test-fixtures'
import { getInitialLineageMeasurements } from './lineage-measurement-cache'

const CHILD_COUNT = 100

function descendantRows(childCount: number): ReturnType<typeof lineageRow>[] {
  return [
    lineageRow('parent', 1),
    ...Array.from({ length: childCount }, (_, n) => lineageRow(`child-${n}`, 2)),
    lineageRow('tail', 1)
  ]
}

function childKeys(): string[] {
  return Array.from({ length: CHILD_COUNT }, (_, n) => `all:|child-${n}`)
}

// Mirrors the group virtualizer's real options so the library resolves sizes as it does in the app.
function mountGroup(tree: LineageVirtualTree, shared: Map<string, number>) {
  const state = { tree }
  const initialMeasurementsCache = getInitialLineageMeasurements(tree, shared, 0)
  const options = (): VirtualizerOptions<HTMLDivElement, HTMLDivElement> => ({
    count: state.tree.nodes.length,
    getScrollElement: () => null,
    getItemKey: (index) => state.tree.nodes[index]!.row.rowKey,
    estimateSize: (index) =>
      shared.get(state.tree.nodes[index]!.row.rowKey) ?? ESTIMATED_LINEAGE_CARD_HEIGHT,
    initialOffset: 0,
    initialMeasurementsCache,
    scrollToFn: vi.fn(),
    observeElementRect: vi.fn(),
    observeElementOffset: vi.fn()
  })
  const instance = new Virtualizer<HTMLDivElement, HTMLDivElement>(options())
  return {
    instance,
    setTree(next: LineageVirtualTree): void {
      state.tree = next
      instance.setOptions(options())
      // Force the measurement pass a render would trigger.
      instance.getTotalSize()
    },
    resolveSize: () => createLineageRowSizeResolver(shared, instance.itemSizeCache),
    // Every size the library actually used, for every key it has measured.
    coreGeometry: () =>
      new Map(
        instance.takeSnapshot().map((item) => [String(item.key), [item.start, item.size] as const])
      )
  }
}

function resolvedGeometry(
  tree: LineageVirtualTree,
  resolveSize: (rowKey: string) => number
): Map<string, readonly [number, number]> {
  const offsets = getLineageVirtualOffsets(tree, resolveSize)
  return new Map(
    tree.nodes.map((node, index) => [
      node.row.rowKey,
      [offsets[index]!, resolveSize(node.row.rowKey)] as const
    ])
  )
}

function expectGeometryAgreement(
  tree: LineageVirtualTree,
  group: ReturnType<typeof mountGroup>
): void {
  const resolveSize = group.resolveSize()
  const resolved = resolvedGeometry(tree, resolveSize)
  const core = group.coreGeometry()
  expect(core.size).toBeGreaterThan(0)
  const disagreed = [...core]
    .filter(([key, [start, size]]) => {
      const spacerGeometry = resolved.get(key)
      return spacerGeometry?.[0] !== start || spacerGeometry[1] !== size
    })
    .map(([key, geometry]) => ({ key, virtualizer: geometry, spacers: resolved.get(key) }))

  expect(disagreed).toEqual([])
  expect(getLineageVirtualOffsets(tree, resolveSize).at(-1)).toBe(group.instance.getTotalSize())
}

describe('lineage spacer geometry agrees with the group virtualizer', () => {
  it.each([56, 140])(
    'keeps reintroduced descendants at the size the library still uses: %i',
    (observed) => {
      const rows = descendantRows(CHILD_COUNT)
      const full = buildLineageVirtualTree(rows)
      const shared = new Map(rows.map((row) => [row.rowKey, observed]))
      const group = mountGroup(full, shared)
      group.setTree(full)
      expectGeometryAgreement(full, group)
      // Precondition: the omitted prefix is measured and far longer than the overscan window.
      expect(childKeys().every((key) => group.coreGeometry().has(key))).toBe(true)
      expect(CHILD_COUNT).toBeGreaterThan(LINEAGE_VIRTUAL_OVERSCAN * 2)

      // Collapse the parent: the viewport prunes heights for rows that left the visible set,
      // but this group's instance survives and keeps their measurements.
      const collapsed = buildLineageVirtualTree([rows[0]!, rows.at(-1)!])
      for (const key of childKeys()) {
        shared.delete(key)
      }
      group.setTree(collapsed)
      expectGeometryAgreement(collapsed, group)
      // Precondition: the same instance survived the collapse still holding the pruned sizes.
      expect(childKeys().every((key) => group.instance.itemSizeCache.get(key) === observed)).toBe(
        true
      )

      // Reopen it: same keys, same order, library's retained sizes rather than the estimate.
      group.setTree(full)
      expect(full.nodes.map((node) => node.row.rowKey)).toEqual([
        'all:|parent',
        ...childKeys(),
        'all:|tail'
      ])
      expect(group.resolveSize()('all:|child-0')).toBe(observed)
      expect(shared.has('all:|child-0')).toBe(false)
      expectGeometryAgreement(full, group)

      // A mounted window repairing only its own rows cannot restore the omitted prefix.
      for (let index = 61; index <= 80; index++) {
        shared.set(full.nodes[index]!.row.rowKey, observed)
      }
      expectGeometryAgreement(full, group)

      const offsets = getLineageVirtualOffsets(full, group.resolveSize())
      const spans = getLineageVirtualChildSpans(full, full.nodes[0]!.children, new Set(), offsets)
      expect(spans).toEqual([
        { type: 'spacer', key: 'all:|child-0', height: CHILD_COUNT * observed }
      ])
    }
  )

  it('agrees after a fresh group instance replaces the pruned one', () => {
    const rows = descendantRows(CHILD_COUNT)
    const full = buildLineageVirtualTree(rows)
    const shared = new Map([
      [rows[0]!.rowKey, 56],
      [rows.at(-1)!.rowKey, 56]
    ])
    const group = mountGroup(full, shared)
    group.setTree(full)

    expect(group.resolveSize()('all:|child-0')).toBe(ESTIMATED_LINEAGE_CARD_HEIGHT)
    expectGeometryAgreement(full, group)
  })

  it('agrees after a reorder that retains every key and measurement', () => {
    const rows = descendantRows(CHILD_COUNT)
    const full = buildLineageVirtualTree(rows)
    const shared = new Map(rows.map((row) => [row.rowKey, 56]))
    const group = mountGroup(full, shared)
    group.setTree(full)

    const children = rows.slice(1, -1)
    const reordered = buildLineageVirtualTree([rows[0]!, ...children.toReversed(), rows.at(-1)!])
    group.setTree(reordered)

    expect(group.resolveSize()('all:|child-0')).toBe(56)
    expectGeometryAgreement(reordered, group)
  })
})
