import { describe, expect, it } from 'vitest'
import { buildSidebarGeometry, sidebarGeometryBoundaries } from '../listing/sidebar-geometry-slots'
import { lineageRow } from '../rows/lineage-virtualization-test-fixtures'
import { selectSidebarViewport } from './sidebar-viewport-selection'

describe('prepared sidebar commit ranges', () => {
  it('retains disjoint current and clamped landing viewports without mounting the intervening prefix', () => {
    const rows = Array.from({ length: 5000 }, (_, index) => lineageRow(`row-${index}`, 0))
    const model = buildSidebarGeometry(rows)
    const boundaries = sidebarGeometryBoundaries(model, new Map())
    const selection = selectSidebarViewport({
      model,
      boundaries,
      rows,
      offset: 1200,
      target: boundaries.at(-1)! + 1000,
      viewport: 400,
      inset: 1,
      targets: [],
      stickyHeaderIndexes: [],
      rootByOuterIndex: new Map(model.roots.map((index) => [index, index]))
    })
    expect(selection.selected.has(10)).toBe(true)
    expect(selection.selected.has(4999)).toBe(true)
    expect(selection.selected.has(2500)).toBe(false)
    expect(selection.selected.size).toBeLessThan(60)
  })
})
