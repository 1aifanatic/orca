import type { VirtualizedScrollAnchor } from '@/hooks/useVirtualizedScrollAnchor'
import type { VirtualItem } from '@tanstack/react-virtual'
import type { SidebarGeometry } from '../listing/sidebar-geometry-slots'

export type SidebarGeometryCorrection = {
  target: number
  epoch: number
  sourceOffset?: number
  shapeAnchor?: boolean
  anchor?: VirtualizedScrollAnchor
  navigation?: {
    key: string
    align: 'start' | 'center' | 'end' | 'auto'
    behavior: 'auto' | 'smooth' | 'instant'
  }
}
export type SidebarScrollRounding = { offset: number; remainder: number; epoch: number }

export function sidebarGeometryConverged(
  model: SidebarGeometry,
  boundaries: readonly number[],
  items: readonly VirtualItem[],
  total: number,
  selectedSlots?: readonly number[]
): boolean {
  return (
    Math.abs(total - boundaries.at(-1)!) < 0.01 &&
    (!selectedSlots ||
      (items.length === selectedSlots.length &&
        items.every((item, index) => item.index === selectedSlots[index]))) &&
    items.every(
      (item) =>
        item.key === model.slots[item.index]?.key &&
        Math.abs(item.start - boundaries[item.index]!) < 0.01 &&
        Math.abs(item.end - boundaries[item.index + 1]!) < 0.01
    )
  )
}
export function clampSidebarOffset(
  offset: number,
  total: number,
  viewport: number,
  inset: number
): number {
  return Math.max(0, Math.min(offset, Math.max(0, Math.round(total + inset) - viewport)))
}

export function resolveSidebarCorrectionTarget(
  correction: SidebarGeometryCorrection | null,
  model: SidebarGeometry,
  boundaries: readonly number[],
  inset: number,
  fallback: number
): number {
  if (!correction) {
    return fallback
  }
  if (correction.navigation) {
    const index = model.nodeByKey.get(correction.navigation.key)
    if (index === undefined) {
      return fallback
    }
    return boundaries[model.nodes[index]!.slot]! + inset
  }
  const anchor = correction.anchor
  if (!anchor) {
    return correction.target
  }
  const key = model.nodeByKey.has(anchor.key)
    ? anchor.key
    : anchor.fallbackKeys?.find((candidate) => model.nodeByKey.has(candidate))
  const index = key ? model.nodeByKey.get(key) : undefined
  return index === undefined
    ? fallback
    : boundaries[model.nodes[index]!.slot]! + inset + (key === anchor.key ? anchor.offset : 0)
}

export function sidebarNavigationOffset(
  start: number,
  end: number,
  offset: number,
  viewport: number,
  topInset: number,
  align: 'start' | 'center' | 'end' | 'auto'
): number {
  if (align === 'center') {
    return (start + end - viewport) / 2
  }
  if (align === 'end') {
    return end - viewport
  }
  if (align === 'start' || start < offset + topInset) {
    return start - topInset
  }
  return end > offset + viewport ? end - viewport : offset
}
