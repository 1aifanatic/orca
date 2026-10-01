// Why: a launch-failed renderer never ran — the OS refused the spawn (macOS exit 1003 under an exhausted
// per-user process limit). That lasts minutes, so 3 reloads in ~750ms only burned the breaker; space retries
// out over ~2 minutes instead, so Orca heals itself once headroom returns.
export const RENDERER_LAUNCH_FAILURE_RETRY_DELAYS_MS: readonly number[] = [
  250, 1_000, 2_000, 4_000, 8_000, 15_000, 30_000, 60_000
]

export type RendererLaunchFailureBackoff = {
  /** Delay before the next retry, or null once the schedule is spent. */
  nextDelayMs: () => number | null
  attempts: () => number
  reset: () => void
}

export function createRendererLaunchFailureBackoff(
  delaysMs: readonly number[] = RENDERER_LAUNCH_FAILURE_RETRY_DELAYS_MS
): RendererLaunchFailureBackoff {
  let attempts = 0
  return {
    nextDelayMs: () => {
      const delay = delaysMs[attempts]
      if (delay === undefined) {
        return null
      }
      attempts += 1
      return delay
    },
    attempts: () => attempts,
    reset: () => {
      attempts = 0
    }
  }
}
