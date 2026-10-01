// When a spare checkout may start (rule 2: never build one while the machine is busy). Numbers come
// from the #23699 perf study: at idle a plain checkout of the 31k-file fixture took 2.1-8.3 s, every
// one under outside load took 17-62 s, and the next create after a slow one was slow up to 105 s
// later and never after.
import { isLocalWorktreeCreateInFlight } from './git/local-worktree-create-activity'

/** A checkout this long is slow on any repo; a larger repo's own baseline can raise the bar. */
export const SLOW_CHECKOUT_FLOOR_MS = 15_000
export const SLOW_CREATE_COOLDOWN_MS = 3 * 60_000
/** About twice the p90 spare build (13.3 s), so base flips waste at most one build per two. */
export const SPARE_ABANDON_WINDOW_MS = 30_000

/**
 * The baseline is the median of a repo's last few checkouts (spare builds or plain adds) that were
 * not themselves slow. A median ignores one cold-cache or warm-cache outlier, and it moves only
 * when most recent checkouts agree, so a ladder of slightly-under-2x steps cannot walk it upward.
 */
const BASELINE_SAMPLES = 5
// In memory only.
const baselineSamplesByRepo = new Map<string, number[]>()
let createsStarted = 0
const lastBaseChangeAbandonByRepo = new Map<string, number>()
let cooldownUntil = 0
let slowCheckoutInFlight = false

function baseline(repoKey: string): number {
  const samples = [...(baselineSamplesByRepo.get(repoKey) ?? [])].sort((a, b) => a - b)
  if (samples.length === 0) {
    return 0
  }
  const middle = Math.floor(samples.length / 2)
  return samples.length % 2 === 1 ? samples[middle] : (samples[middle - 1] + samples[middle]) / 2
}

function recordBaselineSample(repoKey: string, durationMs: number): void {
  const samples = baselineSamplesByRepo.get(repoKey) ?? []
  baselineSamplesByRepo.set(repoKey, [...samples, durationMs].slice(-BASELINE_SAMPLES))
}

function isSlowCheckout(repoKey: string, durationMs: number): boolean {
  return durationMs >= Math.max(SLOW_CHECKOUT_FLOOR_MS, 2 * baseline(repoKey))
}

/** Counts every local create start, so a spare request can tell one happened since it arrived. */
export function noteLocalCreateStarted(): void {
  createsStarted += 1
}

export function localCreatesStarted(): number {
  return createsStarted
}

/** A create's own checkout (plain add or spare handover). */
export function recordLocalCreateCheckoutDuration(
  repoKey: string,
  durationMs: number,
  now = Date.now()
): void {
  if (!isSlowCheckout(repoKey, durationMs)) {
    recordBaselineSample(repoKey, durationMs)
    return
  }
  slowCheckoutInFlight = true
  cooldownUntil = Math.max(cooldownUntil, now + SLOW_CREATE_COOLDOWN_MS)
}

/** A spare's checkout only feeds the baseline; a slow one sets no cooldown. */
export function recordSpareBuildDuration(repoKey: string, durationMs: number): void {
  if (!isSlowCheckout(repoKey, durationMs)) {
    recordBaselineSample(repoKey, durationMs)
  }
}

/** The cooldown runs from the end of the slow create, not from the end of its checkout. */
export function noteLocalCreateSettled(now = Date.now()): void {
  if (slowCheckoutInFlight) {
    slowCheckoutInFlight = false
    cooldownUntil = Math.max(cooldownUntil, now + SLOW_CREATE_COOLDOWN_MS)
  }
}

export type SpareStartRefusal = 'create_in_flight' | 'slow_create_cooldown'

export function spareStartRefusal(now = Date.now()): SpareStartRefusal | null {
  if (isLocalWorktreeCreateInFlight()) {
    return 'create_in_flight'
  }
  return now < cooldownUntil ? 'slow_create_cooldown' : null
}

/** A request for another base may replace the repo's spare once per window. */
export function mayAbandonSpareForBaseChange(repoKey: string, now = Date.now()): boolean {
  const last = lastBaseChangeAbandonByRepo.get(repoKey)
  return last === undefined || now - last >= SPARE_ABANDON_WINDOW_MS
}

export function recordSpareAbandonedForBaseChange(repoKey: string, now = Date.now()): void {
  lastBaseChangeAbandonByRepo.set(repoKey, now)
}

export function _resetSpareGateForTests(): void {
  baselineSamplesByRepo.clear()
  lastBaseChangeAbandonByRepo.clear()
  cooldownUntil = 0
  slowCheckoutInFlight = false
}
