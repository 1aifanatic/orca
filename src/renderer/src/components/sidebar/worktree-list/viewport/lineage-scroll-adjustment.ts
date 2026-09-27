import type { VirtualItem, Virtualizer } from '@tanstack/react-virtual'
import type { MeasuredRowScrollAdjustment } from './use-scroll-suppression'

type SidebarVirtualizer = Virtualizer<HTMLDivElement, HTMLDivElement>

export type LineageScrollAdjustment = (
  groupKey: string,
  item: VirtualItem,
  delta: number,
  instance: SidebarVirtualizer
) => boolean

type OuterScrollAdjustmentOwner = {
  getVirtualItems: () => readonly VirtualItem[]
  itemSizeCache: ReadonlyMap<VirtualItem['key'], number>
}

export function createLineageScrollAdjustment(args: {
  outer: OuterScrollAdjustmentOwner
  shouldAdjustMeasuredRowScroll: MeasuredRowScrollAdjustment
  // The shared map records observations the instance never admitted: equal-size and transferred rows.
  hasPriorObservation: (rowKey: string) => boolean
}): LineageScrollAdjustment {
  const { outer } = args
  return (groupKey, item, _delta, instance) => {
    if (!outer.itemSizeCache.has(groupKey) || instance.scrollOffset === null) {
      return false
    }
    const group = outer.getVirtualItems().find((candidate) => candidate.key === groupKey)
    const scrollOffset = instance.scrollOffset + instance.scrollAdjustments
    // The outer row cannot anchor changes inside a group spanning the viewport.
    if (!group || group.start >= scrollOffset || group.end <= scrollOffset) {
      return false
    }
    return args.shouldAdjustMeasuredRowScroll(
      item,
      instance,
      instance.itemSizeCache.has(item.key) || args.hasPriorObservation(String(item.key))
    )
  }
}
