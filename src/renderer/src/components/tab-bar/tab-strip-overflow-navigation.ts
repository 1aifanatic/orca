import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { bindTabStripContentResizeObservers } from './tab-strip-content-resize-observers'
import {
  computeTabStripOverflowState,
  sameTabStripOverflowState,
  type TabStripOverflowState
} from './tab-strip-scroll-metrics'
import { isTabStripPointerGestureActive } from './tab-strip-pointer-gesture'
import {
  captureTabStripScrollAnchors,
  isLastTabStripTab,
  restoreTabStripScrollAnchor,
  type TabStripScrollAnchor
} from './tab-strip-scroll-anchor'
import {
  findOffscreenOpenedTabStripSlot,
  findTabStripSlot,
  getActiveTabDockSide,
  readTabStripSlotIds,
  revealTabStripSlot,
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

const EMPTY_TAB_STRIP_OVERFLOW_STATE: TabStripOverflowState = {
  hasOverflow: false,
  canScrollStart: false,
  canScrollEnd: false
}

export function useTabStripOverflowNavigation({
  activeVisibleTabId,
  activeDockSlotId,
  layoutKey,
  worktreeId
}: {
  activeVisibleTabId: string | null
  /** The slot drawn active; a client-hosted row can take it without `activeVisibleTabId` changing. */
  activeDockSlotId: string | null
  layoutKey: string
  worktreeId: string
}): {
  tabStripRef: RefObject<HTMLDivElement | null>
  tabStripOverflowState: TabStripOverflowState
  activeTabDockSide: ActiveTabDockSide | null
  scrollTabStrip: (direction: 'start' | 'end', behavior?: ScrollBehavior) => void
  subscribeToStripResize: (listener: () => void) => () => void
} {
  const tabStripRef = useRef<HTMLDivElement>(null)
  const stripResizeListenersRef = useRef<Set<() => void>>(new Set())
  const prevStripRef = useRef<{
    worktreeId: string
    layoutKey: string
    tabIds: ReadonlySet<string>
    activeTabId: string | null
  } | null>(null)
  const stickToEndRef = useRef(false)
  const hoverDeferredRevealIdsRef = useRef<Set<string>>(new Set())
  const scrollAnchorRef = useRef<TabStripScrollAnchor[]>([])
  // Why no thumb position here: it changes every scroll frame, and every tab would re-render with it.
  const [tabStripOverflowState, setTabStripOverflowState] = useState<TabStripOverflowState>(
    EMPTY_TAB_STRIP_OVERFLOW_STATE
  )
  const [activeTabDockSide, setActiveTabDockSide] = useState<ActiveTabDockSide | null>(null)
  const updateTabStripOverflowState = useCallback((): void => {
    const el = tabStripRef.current
    if (!el) {
      return
    }
    const next = computeTabStripOverflowState(el)
    setTabStripOverflowState((previous) =>
      sameTabStripOverflowState(previous, next) ? previous : next
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
    scrollAnchorRef.current = captureTabStripScrollAnchors(el)
  }, [])

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
    const onWheel = (e: WheelEvent): void => {
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        e.preventDefault()
        el.scrollLeft += e.deltaY
        onScroll()
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    el.addEventListener('scroll', onScroll, { passive: true })
    onScroll()

    const handleStripResize = (): void => {
      // If the user is pinned to the right edge, keep it pinned even as tab
      // labels (e.g. "Terminal 5" -> branch name) expand and change scrollWidth.
      if (stickToEndRef.current && !isTabStripPointerGestureActive()) {
        el.scrollLeft = Math.max(0, el.scrollWidth - el.clientWidth)
      }
      updateTabStripOverflowState()
      recordScrollAnchor()
      for (const listener of stripResizeListenersRef.current) {
        listener()
      }
    }

    const disconnectResizeObservers = bindTabStripContentResizeObservers(el, handleStripResize)

    return () => {
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('scroll', onScroll)
      disconnectResizeObservers()
    }
  }, [recordScrollAnchor, updateTabStripOverflowState])

  useEffect(() => {
    const el = tabStripRef.current
    if (!el) {
      return
    }
    const onPointerLeave = (): void => {
      const deferred = hoverDeferredRevealIdsRef.current
      if (deferred.size === 0) {
        return
      }
      hoverDeferredRevealIdsRef.current = new Set()
      if (isTabStripPointerGestureActive()) {
        return
      }
      const knownIds = new Set([...readTabStripSlotIds(el)].filter((id) => !deferred.has(id)))
      const offscreenOpened = findOffscreenOpenedTabStripSlot(el, knownIds)
      if (!offscreenOpened) {
        return
      }
      revealTabStripSlot(el, offscreenOpened)
      stickToEndRef.current = isTabStripScrolledToEnd(el)
      updateTabStripOverflowState()
      recordScrollAnchor()
    }
    el.addEventListener('pointerleave', onPointerLeave)
    return () => el.removeEventListener('pointerleave', onPointerLeave)
  }, [recordScrollAnchor, updateTabStripOverflowState])

  useLayoutEffect(() => {
    const strip = tabStripRef.current
    if (!strip) {
      prevStripRef.current = null
      scrollAnchorRef.current = []
      return
    }
    const prev = prevStripRef.current
    const tabIds = readTabStripSlotIds(strip)
    prevStripRef.current = { worktreeId, layoutKey, tabIds, activeTabId: activeVisibleTabId }
    const workspaceChanged = !prev || prev.worktreeId !== worktreeId
    const layoutChanged = !prev || prev.layoutKey !== layoutKey
    const pointerGestureActive = isTabStripPointerGestureActive()
    let tabClosed = false
    let maintainEnd = false
    const scrollToEnd = (): void => {
      strip.scrollLeft = Math.max(0, strip.scrollWidth - strip.clientWidth)
    }

    if (workspaceChanged) {
      hoverDeferredRevealIdsRef.current.clear()
    } else if (layoutChanged) {
      // Replacing a tab opens a new slot even when the count stays the same.
      const tabOpened = [...tabIds].some((id) => !prev.tabIds.has(id))
      tabClosed = !tabOpened && [...prev.tabIds].some((id) => !tabIds.has(id))
      if (!pointerGestureActive) {
        if (tabOpened) {
          if (prev.activeTabId === activeVisibleTabId) {
            restoreTabStripScrollAnchor(strip, scrollAnchorRef.current, activeVisibleTabId)
            // Defer reveals under the pointer so the next click still lands on the same tab.
            if (strip.matches(':hover')) {
              for (const id of tabIds) {
                if (!prev.tabIds.has(id)) {
                  hoverDeferredRevealIdsRef.current.add(id)
                }
              }
            } else {
              const offscreenOpened = findOffscreenOpenedTabStripSlot(strip, prev.tabIds)
              if (offscreenOpened) {
                revealTabStripSlot(strip, offscreenOpened)
              }
            }
          } else if (isLastTabStripTab(strip, activeVisibleTabId)) {
            scrollToEnd()
            maintainEnd = true
          }
        } else if (stickToEndRef.current) {
          scrollToEnd()
          maintainEnd = true
        } else if (tabClosed) {
          // Hold the leftmost survivor still; tabs after an on-screen close fill its gap.
          restoreTabStripScrollAnchor(strip, scrollAnchorRef.current)
        }
      }
    }

    const activeChanged = !prev || prev.activeTabId !== activeVisibleTabId
    // Closing can select a distant recent tab, which docks without moving the viewport.
    if (activeChanged && activeVisibleTabId && !pointerGestureActive && !tabClosed) {
      const activeSlot = findTabStripSlot(strip, activeVisibleTabId)
      if (activeSlot) {
        revealTabStripSlot(strip, activeSlot)
      }
    }
    // Scroll events arrive after observers, so update the pin before either can use it.
    stickToEndRef.current = isTabStripScrolledToEnd(strip)
    updateTabStripOverflowState()
    recordScrollAnchor()
    const frame = requestAnimationFrame(() => {
      if (maintainEnd && stickToEndRef.current && !isTabStripPointerGestureActive()) {
        scrollToEnd()
      }
      updateTabStripOverflowState()
      recordScrollAnchor()
    })
    return () => cancelAnimationFrame(frame)
  }, [
    activeDockSlotId,
    activeVisibleTabId,
    layoutKey,
    recordScrollAnchor,
    updateTabStripOverflowState,
    worktreeId
  ])

  // Why share these observers: each one watches every tab, so a second set doubles that work.
  const subscribeToStripResize = useCallback((listener: () => void): (() => void) => {
    stripResizeListenersRef.current.add(listener)
    return () => {
      stripResizeListenersRef.current.delete(listener)
    }
  }, [])

  return {
    tabStripRef,
    tabStripOverflowState,
    activeTabDockSide,
    scrollTabStrip,
    subscribeToStripResize
  }
}
