import {
  getElementScrollBounds,
  getScrollTopToRevealBounds,
  resolveSidebarRevealScrollBehavior,
  stopSidebarRevealScroll,
  WORKTREE_SIDEBAR_REVEAL_TOP_INSET
} from '../../worktree-sidebar-reveal'
import { REVEAL_SCROLL_SETTLE_TIMEOUT_MS } from '../../worktree-sidebar-reveal-scroll-settle'

export function createMountedRevealSmoothTarget(
  container: HTMLElement,
  element: HTMLElement,
  behavior: ScrollBehavior,
  now: number
): { expiresAt: number; retarget: (markScroll: (targetTop: number) => void) => void } | null {
  if (resolveSidebarRevealScrollBehavior(behavior) !== 'smooth') {
    return null
  }
  const initialBounds = getElementScrollBounds(container, element)
  const initialTarget = getScrollTopToRevealBounds(
    container,
    initialBounds,
    WORKTREE_SIDEBAR_REVEAL_TOP_INSET
  )
  if (initialTarget === null) {
    return null
  }
  const edge =
    initialBounds.start < container.scrollTop + WORKTREE_SIDEBAR_REVEAL_TOP_INSET ? 'start' : 'end'
  let issuedTarget = Math.max(0, initialTarget)
  let previousDistance = Math.abs(issuedTarget - container.scrollTop)
  return {
    // Bound the original motion plus its measured approach even if rows keep changing.
    expiresAt: now + REVEAL_SCROLL_SETTLE_TIMEOUT_MS * 2,
    retarget: (markScroll) => {
      const bounds = getElementScrollBounds(container, element)
      if (
        getScrollTopToRevealBounds(container, bounds, WORKTREE_SIDEBAR_REVEAL_TOP_INSET) === null
      ) {
        // A fast native frame can reach the moved row before its new endpoint is issued.
        stopSidebarRevealScroll(container, markScroll)
        return
      }
      const target = Math.max(0, initialTarget + bounds[edge] - initialBounds[edge])
      const distance = Math.abs(target - container.scrollTop)
      const closingDistance = Math.max(0, previousDistance - distance)
      previousDistance = distance
      // Cover the next measurement and animation frames when they close faster than the viewport.
      const approachDistance = Math.max(container.clientHeight * 3, closingDistance * 2)
      if (Math.abs(target - issuedTarget) <= 1 || distance > approachDistance) {
        return
      }
      // Retarget near the measured landing; restarting easing on every row stalls distant reveals.
      issuedTarget = target
      markScroll(target)
      container.scrollTo({ top: target, behavior: 'smooth' })
    }
  }
}
