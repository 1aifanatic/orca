import { getTabStripSlots, isDockedTabStripElement } from './tab-strip-slot-geometry'

/** A tab's on-screen x inside the strip viewport, recorded before tabs are added or closed around it. */
export type TabStripScrollAnchor = {
  tabId: string
  offset: number
}

/**
 * Every visible tab in strip order. A docked active tab never counts: it holds its x while the
 * tabs around it move.
 */
export function captureTabStripScrollAnchors(strip: HTMLElement): TabStripScrollAnchor[] {
  const stripRect = strip.getBoundingClientRect()
  const visible: TabStripScrollAnchor[] = []
  for (const tab of getTabStripSlots(strip)) {
    const rect = tab.getBoundingClientRect()
    const tabId = tab.dataset.tabStripSlot
    if (
      tabId &&
      rect.width > 0 &&
      rect.right > stripRect.left &&
      rect.left < stripRect.right &&
      !isDockedTabStripElement(strip, tab)
    ) {
      visible.push({ tabId, offset: rect.left - stripRect.left })
    } else if (rect.left >= stripRect.right) {
      break
    }
  }
  return visible
}

/** Restore a visible survivor, preferring the active tab for insertions. Docked slots cannot measure drift. */
export function restoreTabStripScrollAnchor(
  strip: HTMLElement,
  anchors: readonly TabStripScrollAnchor[],
  preferredTabId: string | null = null
): boolean {
  const tabsById = new Map(getTabStripSlots(strip).map((tab) => [tab.dataset.tabStripSlot, tab]))
  const survivors = anchors.filter(({ tabId }) => {
    const tab = tabsById.get(tabId)
    return tab && !isDockedTabStripElement(strip, tab)
  })
  const anchor = survivors.find(({ tabId }) => tabId === preferredTabId) ?? survivors[0]
  const tab = anchor && tabsById.get(anchor.tabId)
  if (!anchor || !tab) {
    return false
  }
  const drift =
    tab.getBoundingClientRect().left - strip.getBoundingClientRect().left - anchor.offset
  if (drift !== 0) {
    strip.scrollLeft += drift
  }
  return true
}

export function isLastTabStripTab(strip: HTMLElement, tabId: string | null): boolean {
  return tabId !== null && getTabStripSlots(strip).at(-1)?.dataset.tabStripSlot === tabId
}
