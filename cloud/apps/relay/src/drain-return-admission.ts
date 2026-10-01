import {
  RelayPublicAssignmentAdmission,
  type AssignmentAdmissionRejection
} from './public-assignment-admission.js'

type CancelWait = () => void

export type DrainReturnGrant = { kind: 'admitted'; lease: { release(): void } }
export type DrainReturnDeferral = {
  kind: 'deferred'
  reason: AssignmentAdmissionRejection
  retryAfterSeconds: number
}

// Why the minimum: the same two seconds the sticky lane asks for, and the
// lane's own per-host interval, so an honoured Retry-After is never refused as
// a too-fast retry.
export const DRAIN_RETURN_MIN_RETRY_AFTER_SECONDS = 2
// Measured c29 2026-10-01: ~5.8 re-placements/s across 5 directors, i.e. ~860 ms
// of serialized store time per re-placement on one director.
const DRAIN_RETURN_INITIAL_SERVICE_MS = 860
const SERVICE_MS_FLOOR = 20
const SERVICE_MS_CEILING = 15_000
const SERVICE_EWMA_WEIGHT = 0.2

// Hosts whose home cell is isolated for a roll get their own admission budget,
// so a drain's cohort never waits in (or starves) the sticky or placement lanes.
// When the lane is full the host is told when to come back: each deferral takes
// the next free service slot after the work already promised, so a cohort larger
// than the lane can serve returns at the rate the lane drains rather than on
// every client's own 2 s retry.
export class RelayDrainReturnAdmission {
  private readonly lane: RelayPublicAssignmentAdmission
  private serviceMs = DRAIN_RETURN_INITIAL_SERVICE_MS
  private nextReturnAt = 0

  constructor(
    private readonly options: {
      maxConcurrent: number
      maxQueued: number
      waitMs: number
      maxRetryAfterSeconds: number
      now?: () => number
      schedule?: (callback: () => void, delayMs: number) => CancelWait
    }
  ) {
    this.lane = new RelayPublicAssignmentAdmission({
      maxConcurrent: options.maxConcurrent,
      maxQueued: options.maxQueued,
      waitMs: options.waitMs,
      minIntervalMs: DRAIN_RETURN_MIN_RETRY_AFTER_SECONDS * 1_000,
      now: options.now,
      schedule: options.schedule
    })
  }

  async acquire(relayHostId: string): Promise<DrainReturnGrant | DrainReturnDeferral> {
    let reason: AssignmentAdmissionRejection = 'queue-full'
    const lease = await this.lane.acquire(relayHostId, (rejection) => {
      reason = rejection
    })
    if (!lease) {
      return { kind: 'deferred', reason, retryAfterSeconds: this.reserveReturn() }
    }
    const startedAt = this.now()
    let released = false
    return {
      kind: 'admitted',
      lease: {
        release: () => {
          if (released) return
          released = true
          this.recordService(this.now() - startedAt)
          lease.release()
        }
      }
    }
  }

  private reserveReturn(): number {
    const now = this.now()
    const slotMs = this.serviceMs / this.options.maxConcurrent
    const maxMs = this.options.maxRetryAfterSeconds * 1_000
    // Hosts already queued here are served first; a deferral starts after them.
    const earliest =
      now + Math.max(DRAIN_RETURN_MIN_RETRY_AFTER_SECONDS * 1_000, (this.lane.queued + 1) * slotMs)
    this.nextReturnAt = Math.min(Math.max(this.nextReturnAt + slotMs, earliest), now + maxMs)
    return Math.min(
      this.options.maxRetryAfterSeconds,
      Math.max(DRAIN_RETURN_MIN_RETRY_AFTER_SECONDS, Math.ceil((this.nextReturnAt - now) / 1_000))
    )
  }

  private recordService(durationMs: number): void {
    const sample = Math.min(SERVICE_MS_CEILING, Math.max(SERVICE_MS_FLOOR, durationMs))
    this.serviceMs += SERVICE_EWMA_WEIGHT * (sample - this.serviceMs)
  }

  private now(): number {
    return (this.options.now ?? Date.now)()
  }
}
