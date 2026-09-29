import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { bindTabStripContentResizeObservers } from './tab-strip-content-resize-observers'
import {
  computeTabStripScrollMetrics,
  sameTabStripScrollMetrics,
  type TabStripScrollMetrics
} from './tab-strip-scroll-metrics'
import { isTabStripPointerGestureActive } from './tab-strip-pointer-gesture'
import {
  captureTabStripScrollAnchor,
  isLastTabStripTab,
  restoreTabStripScrollAnchor,
  type TabStripScrollAnchor
} from './tab-strip-scroll-anchor'
import {
  findOffscreenOpenedTab,
  getActiveTabDock,
  getActiveTabDockSide,
  readTabStripTabIds,
  revealTabStripElement,
  type ActiveTabDockSide
} from './tab-strip-slot-geometry'

const TAB_STRIP_SCROLL_FRACTION = 0.75
const TAB_STRIP_MIN_SCROLL_STEP_PX = 120

export function scrollTabStripByStep(
  el: HTMLElement,
  direction: 'start' | 'end',
  behavior: ScrollBehavior = 'smooth'
): void {
  const scrollStep = Math.max(
    TAB_STRIP_MIN_SCROLL_STEP_PX,
    el.clientWidth * TAB_STRIP_SCROLL_FRACTION
  )
  el.scrollBy({
    left: direction === 'start' ? -scrollStep : scrollStep,
    behavior
  })
}

function isTabStripScrolledToEnd(el: HTMLElement): boolean {
  const max = Math.max(0, el.scrollWidth - el.clientWidth)
  return el.scrollLeft >= max - 2
}

const EMPTY_TAB_STRIP_OVERFLOW_STATE: TabStripScrollMetrics = {
  hasOverflow: false,
  canScrollStart: false,
  canScrollEnd: false,
  thumbSizeFraction: 1,
  thumbOffsetFraction: 0
}

export function useTabStripOverflowNavigation({
  activeVisibleTabId,
  layoutKey,
  tabCount,
  worktreeId
}: {
  activeVisibleTabId: string | null
  layoutKey: string
  tabCount: number
  worktreeId: string
}): {
  tabStripRef: RefObject<HTMLDivElement | null>
  tabStripOverflowState: TabStripScrollMetrics
  activeTabDockSide: ActiveTabDockSide | null
  scrollTabStrip: (direction: 'start' | 'end', behavior?: ScrollBehavior) => void
} {
  const tabStripRef = useRef<HTMLDivElement>(null)
  const prevStripLenRef = useRef<{ worktreeId: string; len: number } | null>(null)
  const stickToEndRef = useRef(false)
  const activeTabIdRef = useRef<string | null>(null)
  const scrollAnchorRef = useRef<{
    activeTabId: string | null
    anchor: TabStripScrollAnchor | null
  } | null>(null)
  const [tabStripOverflowState, setTabStripOverflowState] = useState<TabStripScrollMetrics>(
    EMPTY_TAB_STRIP_OVERFLOW_STATE
  )
  const [activeTabDockSide, setActiveTabDockSide] = useState<ActiveTabDockSide | null>(null)
  const knownTabIdsRef = useRef<ReadonlySet<string> | null>(null)
  const updateTabStripOverflowState = useCallback((): void => {
    const el = tabStripRef.current
    if (!el) {
      return
    }
    const next = computeTabStripScrollMetrics(el)
    setTabStripOverflowState((previous) =>
      sameTabStripScrollMetrics(previous, next) ? previous : next
    )
    setActiveTabDockSide(getActiveTabDockSide(el))
  }, [])
  const scrollTabStrip = useCallback(
    (direction: 'start' | 'end', behavior: ScrollBehavior = 'smooth'): void => {
      const el = tabStripRef.current
      if (!el) {
        return
      }
      scrollTabStripByStep(el, direction, behavior)
    },
    []
  )
  const recordScrollAnchor = useCallback((): void => {
    const el = tabStripRef.current
    if (!el) {
      return
    }
    const activeTabId = activeTabIdRef.current
    scrollAnchorRef.current = { activeTabId, anchor: captureTabStripScrollAnchor(el, activeTabId) }
  }, [])

  useEffect(() => {
    const el = tabStripRef.current
    if (!el) {
      return
    }
    const onWheel = (e: WheelEvent): void => {
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        e.preventDefault()
        el.scrollLeft += e.deltaY
        updateTabStripOverflowState()
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [updateTabStripOverflowState])

  useEffect(() => {
    const el = tabStripRef.current
    if (!el) {
      return
    }
    const onScroll = (): void => {
      // Only keep sticking while the user hasn't intentionally scrolled away.
      stickToEndRef.current = isTabStripScrolledToEnd(el)
      updateTabStripOverflowState()
      recordScrollAnchor()
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    onScroll()

    const handleStripResize = (): void => {
      updateTabStripOverflowState()
      // If the user is pinned to the right edge, keep it pinned even as tab
      // labels (e.g. "Terminal 5" -> branch name) expand and change scrollWidth.
      if (stickToEndRef.current && !isTabStripPointerGestureActive()) {
        el.scrollLeft = Math.max(0, el.scrollWidth - el.clientWidth)
      }
      recordScrollAnchor()
    }

    const disconnectResizeObservers = bindTabStripContentResizeObservers(el, handleStripResize)

    return () => {
      el.removeEventListener('scroll', onScroll)
      disconnectResizeObservers()
    }
  }, [recordScrollAnchor, updateTabStripOverflowState])

  // Why a ref set first: the growth effect below must see this commit's active tab without re-running on every tab switch.
  useLayoutEffect(() => {
    activeTabIdRef.current = activeVisibleTabId
  }, [activeVisibleTabId])

  useLayoutEffect(() => {
    const strip = tabStripRef.current
    const prev = prevStripLenRef.current
    if (!strip) {
      prevStripLenRef.current = { worktreeId, len: tabCount }
      knownTabIdsRef.current = null
      return
    }
    if (!prev || prev.worktreeId !== worktreeId) {
      prevStripLenRef.current = { worktreeId, len: tabCount }
      knownTabIdsRef.current = readTabStripTabIds(strip)
      updateTabStripOverflowState()
      return
    }
    const pointerGestureActive = isTabStripPointerGestureActive()
    const recorded = scrollAnchorRef.current
    // Compare identities so a replacement is revealed even when the strip count is unchanged.
    const offscreenOpenedTab =
      recorded?.activeTabId === activeTabIdRef.current &&
      knownTabIdsRef.current &&
      !pointerGestureActive &&
      !strip.matches(':hover')
        ? findOffscreenOpenedTab(strip, knownTabIdsRef.current, activeTabIdRef.current)
        : null
    const scrollToEnd = (stick: boolean): void => {
      const el = tabStripRef.current
      if (!el) {
        return
      }
      el.scrollLeft = Math.max(0, el.scrollWidth - el.clientWidth)
      if (stick) {
        stickToEndRef.current = true
      }
      updateTabStripOverflowState()
    }
    if (tabCount > prev.len && !pointerGestureActive) {
      if (recorded?.activeTabId === activeTabIdRef.current) {
        // Why: insertions around the viewed tab keep its on-screen x, the way VS Code and Chrome
        // leave it still; only a tab that lands out of view scrolls, and the active tab docks.
        if (recorded.anchor) {
          restoreTabStripScrollAnchor(strip, recorded.anchor)
        }
        stickToEndRef.current = isTabStripScrolledToEnd(strip)
      } else if (isLastTabStripTab(strip, activeTabIdRef.current)) {
        scrollToEnd(true)
        requestAnimationFrame(() => scrollToEnd(true))
      }
      // A foreground tab opened mid-strip is revealed by the active-tab effect below.
    } else if (stickToEndRef.current && !pointerGestureActive) {
      scrollToEnd(false)
      requestAnimationFrame(() => scrollToEnd(false))
    }
    if (offscreenOpenedTab) {
      revealTabStripElement(strip, offscreenOpenedTab, getActiveTabDock(strip))
      stickToEndRef.current = isTabStripScrolledToEnd(strip)
    }
    knownTabIdsRef.current = readTabStripTabIds(strip)
    prevStripLenRef.current = { worktreeId, len: tabCount }
    updateTabStripOverflowState()
    requestAnimationFrame(updateTabStripOverflowState)
    recordScrollAnchor()
  }, [layoutKey, recordScrollAnchor, tabCount, updateTabStripOverflowState, worktreeId])

  useLayoutEffect(() => {
    const strip = tabStripRef.current
    if (!strip || !activeVisibleTabId) {
      recordScrollAnchor()
      return
    }
    const activeTab = strip.querySelector<HTMLElement>(
      `[data-tab-id="${CSS.escape(activeVisibleTabId)}"]`
    )
    if (!activeTab) {
      recordScrollAnchor()
      return
    }
    if (isTabStripPointerGestureActive()) {
      // Why: active-tab preview changes during a tab press must not move the
      // strip under a stationary pointer before the release decides click/drag.
      requestAnimationFrame(updateTabStripOverflowState)
      recordScrollAnchor()
      return
    }
    revealTabStripElement(strip, activeTab)
    // Why: the scroll event lands after the resize observer, which would re-pin a stale end stick over this reveal.
    stickToEndRef.current = isTabStripScrolledToEnd(strip)
    requestAnimationFrame(updateTabStripOverflowState)
    recordScrollAnchor()
  }, [activeVisibleTabId, recordScrollAnchor, updateTabStripOverflowState])

  return {
    tabStripRef,
    tabStripOverflowState,
    activeTabDockSide,
    scrollTabStrip
  }
}
