/**
 * Whether a user's local worktree create is in flight on this machine.
 *
 * Machine-wide rather than per repo: what a create competes with is the disk, and background git
 * or file deletion for any repo on the same machine slows its checkout just as much.
 *
 * Only background producers wait on this, and only at their entry, before they register shared
 * in-flight state — so a create can join work that is already running but never work parked
 * here. A request/response path a client awaits must never call `whenLocalWorktreeCreatesSettle`.
 */

export const LOCAL_WORKTREE_CREATE_IDLE_DEADLINE_MS = 2 * 60_000

let activeCreates = 0
let settleWaiters: (() => void)[] = []

/** Returns an idempotent release; call it in `finally`. */
export function holdLocalWorktreeCreate(): () => void {
  activeCreates += 1
  let released = false
  return () => {
    if (released) {
      return
    }
    released = true
    activeCreates -= 1
    if (activeCreates === 0) {
      const waiters = settleWaiters
      settleWaiters = []
      for (const wake of waiters) {
        wake()
      }
    }
  }
}

export async function runWithLocalWorktreeCreateHold<T>(operation: () => Promise<T>): Promise<T> {
  const release = holdLocalWorktreeCreate()
  try {
    return await operation()
  } finally {
    release()
  }
}

export function isLocalWorktreeCreateInFlight(): boolean {
  return activeCreates > 0
}

/**
 * Resolves once no local create is in flight, or after `deadlineMs` so a stuck create can never
 * starve background work forever. Background producer entry points only.
 */
export function whenLocalWorktreeCreatesSettle(
  deadlineMs: number = LOCAL_WORKTREE_CREATE_IDLE_DEADLINE_MS
): Promise<void> {
  if (activeCreates === 0) {
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    let settled = false
    const finish = (): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      settleWaiters = settleWaiters.filter((waiter) => waiter !== finish)
      resolve()
    }
    const timer = setTimeout(finish, deadlineMs)
    timer.unref?.()
    settleWaiters.push(finish)
  })
}

export type LocalWorktreeCreateDeferral = {
  /** True while the producer should hold off; starts the wait that calls `onSettle` once. */
  shouldDefer: () => boolean
}

/**
 * For a producer that re-checks on every wake (a queue drain) instead of awaiting. It holds off
 * while creates run and is woken through `onSettle`; once a stretch of creates outlasts the
 * deadline it stops holding off until no create is in flight.
 */
export function createLocalWorktreeCreateDeferral(
  onSettle: () => void,
  deadlineMs: number = LOCAL_WORKTREE_CREATE_IDLE_DEADLINE_MS
): LocalWorktreeCreateDeferral {
  let waiting = false
  let deadlinePassed = false
  return {
    shouldDefer() {
      if (activeCreates === 0) {
        deadlinePassed = false
        return false
      }
      if (deadlinePassed) {
        return false
      }
      if (!waiting) {
        waiting = true
        void whenLocalWorktreeCreatesSettle(deadlineMs).then(() => {
          waiting = false
          deadlinePassed = activeCreates > 0
          onSettle()
        })
      }
      return true
    }
  }
}

export function _resetLocalWorktreeCreateActivityForTests(): void {
  activeCreates = 0
  const waiters = settleWaiters
  settleWaiters = []
  for (const wake of waiters) {
    wake()
  }
}
