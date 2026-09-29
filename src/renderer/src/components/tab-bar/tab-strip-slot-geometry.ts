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
  const dock = getActiveTabDock(strip)
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

function getSlotNaturalSpan(strip: HTMLElement, slot: HTMLElement): [number, number] {
  const left = getSlotNaturalLeft(strip, slot)
  return [left, left + slot.getBoundingClientRect().width]
}

/**
 * Scroll the least distance that shows `el` at its real spot. Why not scrollIntoView: a docked
 * tab already looks on screen, so it would not scroll and a new neighbour would stay hidden.
 * `keep` is shown alongside when both fit; otherwise room is left for it to dock beside `el`.
 */
export function revealTabStripElement(
  strip: HTMLElement,
  el: Element,
  keep: Element | null = null
): void {
  const slot = getTabStripSlot(strip, el)
  if (!slot) {
    return
  }
  let [left, right] = getSlotNaturalSpan(strip, slot)
  const keepSlot = keep ? getTabStripSlot(strip, keep) : null
  if (keepSlot && keepSlot !== slot) {
    const [keepLeft, keepRight] = getSlotNaturalSpan(strip, keepSlot)
    if (Math.max(right, keepRight) - Math.min(left, keepLeft) <= strip.clientWidth) {
      left = Math.min(left, keepLeft)
      right = Math.max(right, keepRight)
    } else if (keepRight <= left) {
      left -= keepRight - keepLeft
    } else if (keepLeft >= right) {
      right += keepRight - keepLeft
    }
  }
  const viewLeft = strip.getBoundingClientRect().left + strip.clientLeft
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

/** The first newly added background tab whose real spot is off screen; null when all are visible. */
export function findOffscreenOpenedTab(
  strip: HTMLElement,
  knownTabIds: ReadonlySet<string>,
  activeTabId: string | null
): HTMLElement | null {
  for (const tab of strip.querySelectorAll<HTMLElement>('[data-tab-id]')) {
    const id = tab.dataset.tabId
    if (!id || id === activeTabId || knownTabIds.has(id)) {
      continue
    }
    const slot = getTabStripSlot(strip, tab)
    if (slot && getTabStripSlotOffscreenSide(strip, slot)) {
      return tab
    }
  }
  return null
}

export function getActiveTabDock(strip: HTMLElement): HTMLElement | null {
  return strip.querySelector<HTMLElement>(`:scope > ${ACTIVE_TAB_DOCK_SELECTOR}`)
}
