import type { TerminalPaneLayoutNode } from '../../../../shared/terminal-tab-types'
import type { PaneManagerHost } from './pane-manager-host'
import { applyDividerStyles, disposeDivider } from './pane-divider'
import { findPaneChildren } from './pane-tree-equalization'
import { refitPanesUnder } from './pane-tree-ops'

// Why: matches serializePaneTree, which drops ratios this close to 0.5, so a round trip never writes.
const RATIO_TOLERANCE = 0.005

type GeometryWrite = {
  split: HTMLElement
  first: HTMLElement
  second: HTMLElement
  isVertical: boolean
  ratio: number
  flipOrientation: boolean
  writeRatio: boolean
}

function readSplitRatio(first: HTMLElement, second: HTMLElement): number {
  const firstGrow = Number.parseFloat(first.style.flex) || 1
  const secondGrow = Number.parseFloat(second.style.flex) || 1
  return firstGrow / (firstGrow + secondGrow)
}

/** False when the DOM's tree differs from `node`, so a mismatch never applies partially. */
function planGeometryWrites(
  node: TerminalPaneLayoutNode,
  el: HTMLElement,
  writes: GeometryWrite[]
): boolean {
  if (node.type === 'leaf') {
    return el.classList.contains('pane') && el.dataset.leafId === node.leafId
  }
  if (!el.classList.contains('pane-split')) {
    return false
  }
  const [first, second, extra] = findPaneChildren(el)
  if (!first || !second || extra) {
    return false
  }
  if (!planGeometryWrites(node.first, first, writes)) {
    return false
  }
  if (!planGeometryWrites(node.second, second, writes)) {
    return false
  }
  const isVertical = node.direction === 'vertical'
  const flipOrientation = el.classList.contains('is-vertical') !== isVertical
  // Why: replay ignores an out-of-range ratio too (wrapInSplit), leaving an equal split.
  const ratio = node.ratio !== undefined && node.ratio > 0 && node.ratio < 1 ? node.ratio : 0.5
  const writeRatio = Math.abs(readSplitRatio(first, second) - ratio) > RATIO_TOLERANCE
  if (flipOrientation || writeRatio) {
    writes.push({ split: el, first, second, isVertical, ratio, flipOrientation, writeRatio })
  }
  return true
}

function flipSplitOrientation(
  write: GeometryWrite,
  createDivider: (isVertical: boolean) => HTMLElement
): void {
  const { split, isVertical } = write
  split.classList.toggle('is-vertical', isVertical)
  split.classList.toggle('is-horizontal', !isVertical)
  split.style.flexDirection = isVertical ? 'row' : 'column'
  // Why: a divider binds its drag axis at creation, so an orientation flip needs a new one.
  const oldDivider = Array.from(split.children).find(
    (child): child is HTMLElement =>
      child instanceof HTMLElement && child.classList.contains('pane-divider')
  )
  const divider = createDivider(isVertical)
  if (oldDivider) {
    disposeDivider(oldDivider)
    split.replaceChild(divider, oldDivider)
  } else {
    split.insertBefore(divider, write.second)
  }
}

/**
 * Applies split orientation and ratios from `layout` to the mounted pane tree
 * in place. Only applies when the DOM already holds exactly the layout's
 * leaves in the same tree shape; returns the splits it changed.
 */
export function applyPaneLayoutGeometry(args: {
  root: HTMLElement
  layout: TerminalPaneLayoutNode
  createDivider: (isVertical: boolean) => HTMLElement
}): HTMLElement[] {
  const top = args.root.firstElementChild
  if (!(top instanceof HTMLElement)) {
    return []
  }
  const writes: GeometryWrite[] = []
  if (!planGeometryWrites(args.layout, top, writes)) {
    return []
  }
  for (const write of writes) {
    if (write.flipOrientation) {
      flipSplitOrientation(write, args.createDivider)
    }
    if (write.writeRatio) {
      write.first.style.flex = `${write.ratio} 1 0%`
      write.second.style.flex = `${1 - write.ratio} 1 0%`
    }
  }
  return writes.map((write) => write.split)
}

export function applyManagedPaneLayoutGeometry(
  host: PaneManagerHost,
  layout: TerminalPaneLayoutNode
): boolean {
  const changedSplits = applyPaneLayoutGeometry({
    root: host.root,
    layout,
    createDivider: host.createDivider
  })
  if (changedSplits.length === 0) {
    return false
  }
  applyDividerStyles(host.root, host.getStyleOptions())
  for (const split of changedSplits) {
    refitPanesUnder(split, host.panes)
  }
  return true
}
