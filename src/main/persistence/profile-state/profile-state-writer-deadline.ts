import {
  getSystemPowerState,
  subscribeSystemPowerLifecycle,
  type SystemPowerLifecycleListener,
  type SystemPowerState
} from '../../system-power-lifecycle'

/**
 * A timer this late proves the main loop, not the worker, missed the window: a
 * reply may already be queued behind it. Timers and performance.now() share
 * libuv's monotonic clock, so wall-clock changes cannot fake or hide lateness.
 */
export const PROFILE_STATE_WRITER_OVERDUE_GRACE_MS = 5_000
/** Bound grace so repeated stalls or a missed resume cannot hide a hung worker forever. */
export const PROFILE_STATE_WRITER_MAX_GRACES = 3

export type ProfileStateWriterDeadlineExpiry = {
  timeoutMs: number
  elapsedMs: number
  overdueMs: number
  graces: number
  powerState: SystemPowerState
}

export type ProfileStateWriterDeadlineOptions = {
  now?: () => number
  subscribePowerLifecycle?: (listener: SystemPowerLifecycleListener) => () => void
  onGrace?: (expiry: ProfileStateWriterDeadlineExpiry) => void
}

/**
 * Fault only after a full window in which the main loop ran on time while awake.
 * Late or suspended expiries re-arm instead, which lets queued replies drain in
 * either delivery order; resume grants a fresh window without spending grace.
 */
export function createProfileStateWriterDeadline(
  timeoutMs: number,
  onTimeout: (expiry: ProfileStateWriterDeadlineExpiry) => void,
  {
    now = () => performance.now(),
    subscribePowerLifecycle = subscribeSystemPowerLifecycle,
    onGrace
  }: ProfileStateWriterDeadlineOptions = {}
): { clear: () => void } {
  const startedAt = now()
  let armedAt = startedAt
  let graces = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let active = true
  const arm = (): void => {
    clearTimeout(timer)
    armedAt = now()
    timer = setTimeout(expire, timeoutMs)
  }
  const clear = (): void => {
    if (!active) {
      return
    }
    active = false
    clearTimeout(timer)
    timer = undefined
    unsubscribe()
  }
  function expire(): void {
    timer = undefined
    if (!active) {
      return
    }
    const current = now()
    const expiry = {
      timeoutMs,
      elapsedMs: Math.max(0, current - startedAt),
      overdueMs: Math.max(0, current - armedAt - timeoutMs),
      graces,
      powerState: getSystemPowerState()
    }
    if (
      graces < PROFILE_STATE_WRITER_MAX_GRACES &&
      (expiry.overdueMs >= PROFILE_STATE_WRITER_OVERDUE_GRACE_MS || expiry.powerState !== 'awake')
    ) {
      graces += 1
      arm()
      onGrace?.({ ...expiry, graces })
      return
    }
    clear()
    onTimeout(expiry)
  }
  // Subscription replays the current state synchronously; only later resumes re-arm.
  let subscribed = false
  const unsubscribe = subscribePowerLifecycle({
    onSuspend: () => {},
    onResume: () => {
      if (subscribed && active) {
        arm()
      }
    }
  })
  subscribed = true
  arm()
  return { clear }
}
