export type RendererPublicationThrottleTarget = {
  isDestroyed?: () => boolean
  isFocused?: () => boolean
  setBackgroundThrottling: (allowed: boolean) => void
  capturePage: (
    rect: { x: number; y: number; width: number; height: number },
    opts: { stayHidden: boolean }
  ) => Promise<unknown>
}

// Why: an empty rect keeps the hidden capture side-effect free (Chromium DCHECKs a sized stayHidden capture).
const REHIDE_CAPTURE_RECT = { x: 0, y: 0, width: 0, height: 0 }

// Why: re-throttling only clears Electron's disable_hidden flag, so a hide swallowed while leased never
// replays; a stayHidden capture's completion re-applies the current visibility without showing the page.
function rehideCoveredRenderer(target: RendererPublicationThrottleTarget): void {
  // Why: a focused renderer sits in an on-screen key window, so it has no swallowed hide to replay.
  if (target.isFocused?.() === true) {
    return
  }
  try {
    target.capturePage(REHIDE_CAPTURE_RECT, { stayHidden: true }).catch(() => {})
  } catch {
    // Best-effort: a failed re-hide leaves the residue until the next cover cycle, never a stuck lease.
  }
}

export class RendererPublicationThrottle {
  private readonly leasesByTarget = new Map<RendererPublicationThrottleTarget, number>()

  acquire(target: RendererPublicationThrottleTarget): () => void {
    const leaseCount = this.leasesByTarget.get(target) ?? 0
    if (leaseCount === 0) {
      target.setBackgroundThrottling(false)
    }
    this.leasesByTarget.set(target, leaseCount + 1)
    let released = false
    return () => {
      if (released) {
        return
      }
      released = true
      const remaining = (this.leasesByTarget.get(target) ?? 1) - 1
      if (remaining > 0) {
        this.leasesByTarget.set(target, remaining)
        return
      }
      this.leasesByTarget.delete(target)
      if (target.isDestroyed?.() !== true) {
        target.setBackgroundThrottling(true)
        rehideCoveredRenderer(target)
      }
    }
  }
}

// Why: one instance per process, or two owners of the same window would re-throttle it under each other's lease.
export const rendererPublicationThrottle = new RendererPublicationThrottle()
