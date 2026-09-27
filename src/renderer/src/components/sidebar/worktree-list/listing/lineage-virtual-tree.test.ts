import { describe, expect, it } from 'vitest'
import { lineageRow } from '../rows/lineage-virtualization-test-fixtures'
import {
  buildLineageVirtualTree,
  createLineageRowSizeResolver,
  getLineageRevealMeasurementIndexes,
  getLineageVirtualChildSpans,
  getLineageVirtualOffsets,
  retainLineageVirtualAncestors
} from './lineage-virtual-tree'

describe('lineage virtual tree', () => {
  it('premeasures a reveal viewport and overscan as estimated rows shrink to actual heights', () => {
    const tree = buildLineageVirtualTree(
      Array.from({ length: 500 }, (_, n) => lineageRow(`child-${n}`))
    )
    const estimated = getLineageVirtualOffsets(tree, createLineageRowSizeResolver(new Map()))
    const measured = getLineageVirtualOffsets(
      tree,
      createLineageRowSizeResolver(new Map(tree.nodes.map((node) => [node.row.rowKey, 40])))
    )
    expect(getLineageRevealMeasurementIndexes(400, estimated, 400)).toEqual(
      Array.from({ length: 31 }, (_, n) => n + 385)
    )
    expect(getLineageRevealMeasurementIndexes(400, measured, 400)).toEqual(
      Array.from({ length: 41 }, (_, n) => n + 380)
    )
    expect(getLineageRevealMeasurementIndexes(0, measured, 400)[0]).toBe(0)
    expect(getLineageRevealMeasurementIndexes(499, measured, 400).at(-1)).toBe(499)
  })

  it('indexes a deep chain in one pass and retains only the requested ancestor path', () => {
    const rows = Array.from({ length: 2000 }, (_, n) => lineageRow(`child-${n}`, n + 1))
    rows.push(lineageRow('other-root'), lineageRow('other-child', 2))
    const tree = buildLineageVirtualTree(rows)
    expect(tree.roots).toEqual([0, 2000])
    expect(tree.nodes[0]?.endIndex).toBe(2000)
    expect(tree.nodes[1999]?.parentIndex).toBe(1998)
    expect(retainLineageVirtualAncestors(tree, [2001])).toEqual(new Set([2001, 2000]))
  })

  it('coalesces hidden sibling subtrees and preserves their measured height including gaps', () => {
    const rows = [
      lineageRow('first'),
      lineageRow('nested', 2),
      lineageRow('second'),
      lineageRow('third')
    ]
    const tree = buildLineageVirtualTree(rows)
    const offsets = getLineageVirtualOffsets(
      tree,
      createLineageRowSizeResolver(new Map(rows.map((row) => [row.rowKey, 100])))
    )
    expect(getLineageVirtualChildSpans(tree, tree.roots, new Set([2]), offsets)).toEqual([
      { type: 'spacer', key: rows[0]!.rowKey, height: 196 },
      { type: 'row', index: 2 },
      { type: 'spacer', key: rows[3]!.rowKey, height: 100 }
    ])
    expect(getLineageVirtualChildSpans(tree, tree.roots, new Set(), offsets)).toEqual([
      { type: 'spacer', key: rows[0]!.rowKey, height: 400 }
    ])
  })

  it('resolves a row size the way the virtualizer does: instance cache, shared height, estimate', () => {
    const rows = [lineageRow('cached'), lineageRow('shared'), lineageRow('unmeasured')]
    const tree = buildLineageVirtualTree(rows)
    const shared = new Map([
      [rows[0]!.rowKey, 70],
      [rows[1]!.rowKey, 50]
    ])
    const instanceSizes = new Map<string | number | bigint, number>([[rows[0]!.rowKey, 56]])
    const resolveSize = createLineageRowSizeResolver(shared, instanceSizes)

    expect(rows.map((row) => resolveSize(row.rowKey))).toEqual([56, 50, 96])
    expect(getLineageVirtualOffsets(tree, resolveSize)).toEqual([0, 56, 106, 202])
    // A shared prune must not move a row the instance still measures.
    shared.delete(rows[0]!.rowKey)
    expect(resolveSize(rows[0]!.rowKey)).toBe(56)
  })
})
