import type { MutableRefObject } from 'react'
import type { VirtualizedScrollAnchor } from '@/hooks/useVirtualizedScrollAnchor'
import type { SidebarGeometry } from '../listing/sidebar-geometry-slots'

export type SidebarObservation = { prefix: number; closing: number | null; width: number }
export type SidebarGeometryLedger = {
  style: boolean
  layoutContext: string
  width: number
  sizes: Map<string, number>
  observed: Set<string>
  contexts: Map<string, string>
}
const reconciledModels = new WeakMap<SidebarGeometryLedger, SidebarGeometry>()
export type SidebarGeometryOwner = MutableRefObject<VirtualizedScrollAnchor>
const ledgers = new WeakMap<SidebarGeometryOwner, SidebarGeometryLedger>()
export function getSidebarGeometryLedger(owner: SidebarGeometryOwner): SidebarGeometryLedger {
  let ledger = ledgers.get(owner)
  if (!ledger) {
    ledger = {
      style: false,
      layoutContext: '',
      width: 0,
      sizes: new Map(),
      observed: new Set(),
      contexts: new Map()
    }
    ledgers.set(owner, ledger)
  }
  return ledger
}
export function reconcileSidebarLedger(
  ledger: SidebarGeometryLedger,
  model: SidebarGeometry,
  style: boolean,
  width: number,
  layoutContext = ''
): boolean {
  if (
    reconciledModels.get(ledger) === model &&
    ledger.style === style &&
    ledger.layoutContext === layoutContext &&
    (width <= 0 || ledger.width === width)
  ) {
    return false
  }
  reconciledModels.set(ledger, model)
  let changed = false
  if (
    ledger.style !== style ||
    ledger.layoutContext !== layoutContext ||
    (width > 0 && ledger.width !== width)
  ) {
    changed = ledger.sizes.size > 0
    ledger.sizes.clear()
    ledger.observed.clear()
    ledger.contexts.clear()
    ledger.style = style
    ledger.layoutContext = layoutContext
    ledger.width = width
  }
  const keys = new Set(model.slots.map((slot) => slot.key))
  for (const slot of model.slots) {
    const node = model.nodes[slot.node]!
    const depth = 'depth' in node.row ? node.row.depth : 0
    const context = JSON.stringify([
      node.gap,
      node.parent === null ? null : model.nodes[node.parent]!.key,
      depth,
      'groupDepth' in node.row ? node.row.groupDepth : 0
    ])
    if (ledger.contexts.has(slot.key) && ledger.contexts.get(slot.key) !== context) {
      ledger.sizes.delete(slot.key)
      ledger.observed.delete(slot.key)
      changed = true
    }
    ledger.contexts.set(slot.key, context)
  }
  for (const key of ledger.contexts.keys()) {
    if (!keys.has(key)) {
      ledger.contexts.delete(key)
    }
  }
  for (const key of ledger.sizes.keys()) {
    if (!keys.has(key)) {
      ledger.sizes.delete(key)
      ledger.observed.delete(key)
      changed = true
    }
  }
  return changed
}

// Relative rectangles cancel the shared outer drag translation.
export function readSidebarObservation(
  element: HTMLElement,
  children: HTMLElement | null
): SidebarObservation | null {
  if (!element.isConnected || (children && !children.isConnected)) {
    return null
  }
  const content = element.firstElementChild
  const surface =
    children && element.hasAttribute('data-worktree-virtual-row') && content instanceof HTMLElement
      ? content
      : element
  const rect = surface.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) {
    return null
  }
  if (!children) {
    return { prefix: rect.height, closing: null, width: rect.width }
  }
  const childRect = children.getBoundingClientRect()
  const prefix = childRect.top - rect.top
  const closing = rect.bottom - childRect.bottom
  if (prefix < 0 || closing < 0) {
    return null
  }
  return { prefix, closing, width: rect.width }
}

export function publishSidebarObservation(
  ledger: SidebarGeometryLedger,
  model: SidebarGeometry,
  nodeIndex: number,
  observation: SidebarObservation
): boolean {
  const node = model.nodes[nodeIndex]
  if (!node || (node.close !== null) !== (observation.closing !== null)) {
    return false
  }
  let changed = false
  const record = (index: number, size: number) => {
    const slot = model.slots[index]!
    if (!ledger.observed.has(slot.key) || ledger.sizes.get(slot.key) !== size) {
      changed = true
    }
    ledger.observed.add(slot.key)
    ledger.sizes.set(slot.key, size)
  }
  record(node.slot, observation.prefix + (node.close === null ? node.gap : 0))
  if (node.close !== null) {
    record(node.close, observation.closing! + node.gap)
  }
  return changed
}
