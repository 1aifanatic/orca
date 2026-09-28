/** Marks each tab's direct child of the strip; menu triggers rendered beside tabs are out of flow and unmarked. */
export const TAB_STRIP_SLOT_SELECTOR = '[data-tab-strip-slot]'
/** Marks the slot of the tab that renders active; it is sticky, so it docks to the edge it would scroll past. */
export const ACTIVE_TAB_DOCK_SELECTOR = '[data-active-tab-dock]'

export type ActiveTabDockSide = 'start' | 'end'

/** The strip's direct child that holds `el`, or null when `el` is not inside the strip. */
export function getTabStripSlot(strip: HTMLElement, el: Element): HTMLElement | null {
  let node: Element | null = el
  while (node && node.parentElement !== strip) {
    node = node.parentElement
  }
  return node instanceof HTMLElement ? node : null
}

/** Viewport x where `slot` sits in the tab order, ignoring any sticky offset. */
function getSlotNaturalLeft(strip: HTMLElement, slot: HTMLElement): number {
  let prev = slot.previousElementSibling
  while (prev && !prev.matches(TAB_STRIP_SLOT_SELECTOR)) {
    prev = prev.previousElementSibling
  }
  if (!prev) {
    return strip.getBoundingClientRect().left + strip.clientLeft - strip.scrollLeft
  }
  // Why: the tab right after a docked one must not inherit the dock's on-screen edge.
  if (prev instanceof HTMLElement && prev.matches(ACTIVE_TAB_DOCK_SELECTOR)) {
    return getSlotNaturalLeft(strip, prev) + prev.getBoundingClientRect().width
  }
  return prev.getBoundingClientRect().right
}

/** Which edge `slot` would be past without sticky positioning; null when its real spot is on screen. */
export function getTabStripSlotOffscreenSide(
  strip: HTMLElement,
  slot: HTMLElement
): ActiveTabDockSide | null {
  const viewLeft = strip.getBoundingClientRect().left + strip.clientLeft
  const left = getSlotNaturalLeft(strip, slot)
  const right = left + slot.getBoundingClientRect().width
  if (left < viewLeft - 1) {
    return 'start'
  }
  if (right > viewLeft + strip.clientWidth + 1) {
    return 'end'
  }
  return null
}

export function getActiveTabDockSide(strip: HTMLElement): ActiveTabDockSide | null {
  const dock = strip.querySelector<HTMLElement>(`:scope > ${ACTIVE_TAB_DOCK_SELECTOR}`)
  return dock ? getTabStripSlotOffscreenSide(strip, dock) : null
}

/** True when `el` belongs to the active tab and is drawn docked at an edge instead of its real spot. */
export function isDockedTabStripElement(strip: HTMLElement, el: Element): boolean {
  const slot = getTabStripSlot(strip, el)
  return (
    slot !== null &&
    slot.matches(ACTIVE_TAB_DOCK_SELECTOR) &&
    getTabStripSlotOffscreenSide(strip, slot) !== null
  )
}

/**
 * Scroll the least distance that shows `el` at its real spot. Why not scrollIntoView: a docked
 * tab already looks on screen, so it would not scroll and a new neighbour would stay hidden.
 */
export function revealTabStripElement(strip: HTMLElement, el: Element): void {
  const slot = getTabStripSlot(strip, el)
  if (!slot) {
    return
  }
  const viewLeft = strip.getBoundingClientRect().left + strip.clientLeft
  const left = getSlotNaturalLeft(strip, slot)
  const right = left + slot.getBoundingClientRect().width
  if (left < viewLeft) {
    strip.scrollLeft -= viewLeft - left
  } else if (right > viewLeft + strip.clientWidth) {
    strip.scrollLeft += Math.min(left - viewLeft, right - viewLeft - strip.clientWidth)
  }
}

export function readTabStripTabIds(strip: HTMLElement): ReadonlySet<string> {
  const ids = new Set<string>()
  for (const tab of strip.querySelectorAll<HTMLElement>('[data-tab-id]')) {
    if (tab.dataset.tabId) {
      ids.add(tab.dataset.tabId)
    }
  }
  return ids
}

/** The edge past which a newly added background tab landed; null when every new tab is on screen. */
export function findOffscreenOpenedTabSide(
  strip: HTMLElement,
  knownTabIds: ReadonlySet<string>,
  activeTabId: string | null
): ActiveTabDockSide | null {
  for (const tab of strip.querySelectorAll<HTMLElement>('[data-tab-id]')) {
    const id = tab.dataset.tabId
    if (!id || id === activeTabId || knownTabIds.has(id)) {
      continue
    }
    const slot = getTabStripSlot(strip, tab)
    const side = slot ? getTabStripSlotOffscreenSide(strip, slot) : null
    if (side) {
      return side
    }
  }
  return null
}
