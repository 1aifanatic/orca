import type { PreparedCheckoutOrigin } from '../shared/worktree/create-types'
import { beginPreparationWork, type PreparationWork } from './worktree-create-concurrency'

/** What a create's event reports about the prepared checkout it used: who asked for it, and the
 *  disk work and timing of its latest build or tip refresh. Recording only; never gates the pool. */
export type PreparationActivity = {
  /** Counts the latest build or refresh as disk work competing with creates. */
  readonly work: PreparationWork
  /** An explicit prefetch asked for this checkout too. */
  requestedByPrefetch(): void
  /** Covers `ready`, the checkout's latest build or tip refresh, until it settles. */
  track(ready: Promise<void>): void
  origin(): PreparedCheckoutOrigin
  /** Build time of the latest work, and how long it then sat ready before `claimedAt`. */
  timesAt(claimedAt: number): { buildMs: number; idleMs: number }
}

export function createPreparationActivity(kind: 'explicit' | 'automatic'): PreparationActivity {
  let work = beginPreparationWork()
  let startedAt = performance.now()
  let readyAt: number | undefined
  let latest: Promise<void> | undefined
  let prefetchRequested = false

  return {
    get work() {
      return work
    },
    requestedByPrefetch() {
      prefetchRequested = true
    },
    track(ready) {
      // A refresh queued after the build finished is new work, timed from its own start.
      if (readyAt !== undefined) {
        work = beginPreparationWork()
        startedAt = performance.now()
        readyAt = undefined
      }
      latest = ready
      const current = work
      const settle = (succeeded: boolean): void => {
        // A refresh chained onto this work extends it; only the latest settle ends it.
        if (latest !== ready) {
          return
        }
        if (succeeded) {
          readyAt = performance.now()
        }
        current.end()
      }
      void ready.then(
        () => settle(true),
        () => settle(false)
      )
    },
    origin() {
      if (kind === 'explicit') {
        return 'prefetch'
      }
      return prefetchRequested ? 'rearm_then_prefetch' : 'rearm'
    },
    timesAt(claimedAt) {
      // A create that waited for the work reports no idle time.
      const finishedAt = readyAt ?? claimedAt
      return {
        buildMs: Math.max(0, finishedAt - startedAt),
        idleMs: Math.max(0, claimedAt - finishedAt)
      }
    }
  }
}
