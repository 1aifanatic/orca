import { Virtualizer, type VirtualItem } from '@tanstack/react-virtual'
import { describe, expect, it, vi } from 'vitest'
import { createLineageScrollAdjustment } from './lineage-scroll-adjustment'
import {
  shouldAdjustWorktreeSidebarMeasuredRowScroll,
  type MeasuredRowScrollAdjustment
} from './use-scroll-suppression'

function row(key: string, start: number, size: number): VirtualItem {
  return { key, index: 0, start, size, end: start + size, lane: 0 }
}

function fixture() {
  const inner = new Virtualizer<HTMLDivElement, HTMLDivElement>({
    count: 1,
    getScrollElement: () => null,
    estimateSize: () => 100,
    scrollToFn: vi.fn(),
    observeElementRect: vi.fn(),
    observeElementOffset: vi.fn()
  })
  inner.scrollOffset = 400
  inner.itemSizeCache.set('child', 100)
  const suppression = { now: 1_000, until: 0 }
  const group = row('lineage-group:root', 0, 1_000)
  const measuredHeights = new Map<string, number>()
  const outer = {
    getVirtualItems: () => [group],
    itemSizeCache: new Map<string | number | bigint, number>([[group.key, group.size]])
  }
  // Mirrors the outer virtualizer's policy call, including its default observation status.
  const shouldAdjustMeasuredRowScroll: MeasuredRowScrollAdjustment = vi.fn(
    (item, instance, hasPriorObservation = instance.itemSizeCache.has(item.key)) =>
      shouldAdjustWorktreeSidebarMeasuredRowScroll({
        isScrolling: instance.isScrolling,
        now: suppression.now,
        suppressUntil: suppression.until,
        itemStart: item.start,
        itemEnd: item.end,
        scrollOffset: (instance.scrollOffset ?? 0) + instance.scrollAdjustments,
        isFirstMeasurement: !hasPriorObservation,
        scrollDirection: instance.scrollDirection
      })
  )
  return {
    inner,
    outer,
    group,
    suppression,
    measuredHeights,
    shouldAdjustMeasuredRowScroll,
    shouldAdjust: createLineageScrollAdjustment({
      outer,
      shouldAdjustMeasuredRowScroll,
      hasPriorObservation: (rowKey) => measuredHeights.has(rowKey)
    })
  }
}

describe('lineage descendant scroll adjustment ownership', () => {
  it('anchors an above-viewport child inside a measured group spanning the viewport', () => {
    const { inner, group, shouldAdjust, shouldAdjustMeasuredRowScroll } = fixture()
    const child = row('child', 150, 100)

    expect(shouldAdjust(String(group.key), child, 40, inner)).toBe(true)
    expect(shouldAdjustMeasuredRowScroll).toHaveBeenCalledExactlyOnceWith(child, inner, true)
  })

  it.each([
    { start: 0, size: 400 },
    { start: 500, size: 1_000 },
    { start: 400, size: 1_000 }
  ])('leaves correction with the outer row outside the spanning case: %j', ({ start, size }) => {
    const { inner, group, shouldAdjust, shouldAdjustMeasuredRowScroll } = fixture()
    Object.assign(group, { start, size, end: start + size })

    expect(shouldAdjust(String(group.key), row('child', 150, 100), 40, inner)).toBe(false)
    expect(shouldAdjustMeasuredRowScroll).not.toHaveBeenCalled()
  })

  it('leaves the group’s first measurement with the outer virtualizer', () => {
    const { inner, outer, group, shouldAdjust, shouldAdjustMeasuredRowScroll } = fixture()
    outer.itemSizeCache.clear()

    expect(shouldAdjust(String(group.key), row('child', 150, 100), 40, inner)).toBe(false)
    expect(shouldAdjustMeasuredRowScroll).not.toHaveBeenCalled()
  })

  it('does not adjust an unmounted group or an uninitialized scroll position', () => {
    const { inner, outer, group, shouldAdjust, shouldAdjustMeasuredRowScroll } = fixture()
    outer.itemSizeCache.set('old-group', 1_000)
    expect(shouldAdjust('old-group', row('child', 150, 100), 40, inner)).toBe(false)
    inner.scrollOffset = null
    expect(shouldAdjust(String(group.key), row('child', 150, 100), 40, inner)).toBe(false)
    expect(shouldAdjustMeasuredRowScroll).not.toHaveBeenCalled()
  })

  it('preserves scroll, expansion suppression, and backward-scroll policy', () => {
    const { inner, group, suppression, shouldAdjust } = fixture()
    const child = row('child', 150, 100)
    inner.isScrolling = true
    expect(shouldAdjust(String(group.key), child, 40, inner)).toBe(false)
    inner.isScrolling = false
    suppression.until = 1_500
    expect(shouldAdjust(String(group.key), child, 40, inner)).toBe(false)
    suppression.until = 0
    inner.scrollDirection = 'backward'
    expect(shouldAdjust(String(group.key), child, 40, inner)).toBe(false)
  })

  it('uses the child measurement cache and applies first-measurement fold policy', () => {
    const { inner, group, shouldAdjust } = fixture()
    const child = row('child', 350, 100)
    expect(shouldAdjust(String(group.key), child, 40, inner)).toBe(false)
    inner.itemSizeCache.delete('child')
    expect(shouldAdjust(String(group.key), child, 40, inner)).toBe(true)
  })

  it('honors pending scroll adjustments when deciding which virtualizer owns correction', () => {
    const { inner, group, shouldAdjust } = fixture()
    inner.scrollOffset = 0
    inner.scrollAdjustments = 400
    expect(shouldAdjust(String(group.key), row('child', 150, 100), 40, inner)).toBe(true)
  })

  it.each([
    { label: 'a height equal to the estimate the instance never admitted', shared: 100 },
    { label: 'a transferred row this instance was never seeded with', shared: 56 }
  ])('treats a shared prior observation as a re-measure: $label', ({ shared }) => {
    const { inner, group, shouldAdjust, measuredHeights, shouldAdjustMeasuredRowScroll } = fixture()
    inner.itemSizeCache.delete('child')
    measuredHeights.set('child', shared)
    const spanning = row('child', 350, 100)

    // Spanning growth on an already-observed row must stay with the row, not move scrollTop.
    expect(shouldAdjust(String(group.key), spanning, 40, inner)).toBe(false)
    expect(shouldAdjustMeasuredRowScroll).toHaveBeenCalledExactlyOnceWith(spanning, inner, true)
  })

  it('still compensates a genuinely unobserved row and an observed row above the fold', () => {
    const { inner, group, shouldAdjust, measuredHeights } = fixture()
    inner.itemSizeCache.delete('child')

    expect(shouldAdjust(String(group.key), row('child', 350, 100), 40, inner)).toBe(true)
    measuredHeights.set('child', 100)
    expect(shouldAdjust(String(group.key), row('child', 150, 100), 40, inner)).toBe(true)
    inner.scrollDirection = 'backward'
    expect(shouldAdjust(String(group.key), row('child', 150, 100), 40, inner)).toBe(false)
  })
})
