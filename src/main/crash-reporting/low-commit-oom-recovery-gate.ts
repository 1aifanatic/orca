import type { CrashReportDetailValue } from '../../shared/crash-reporting'
import { preGoneSystemMemoryDetails } from './pre-gone-host-memory'
import { SYSTEM_MEMORY_KEY_PREFIX } from './system-memory-details'

// Why: when Windows commit is exhausted by another program, a recovery reload OOMs again within seconds
// (launch 13084: 3.5 s after the reload; launch 22912: 34 s), so a repeat OOM on a starved host asks the user instead.
export const LOW_COMMIT_REPEAT_OOM_WINDOW_MS = 5 * 60_000
export const LOW_COMMIT_AVAILABLE_MB_THRESHOLD = 512
// Two missed 10 s sampler ticks: an older reading may predate the squeeze or its relief.
const LOW_COMMIT_MAX_SAMPLE_AGE_MS = 30_000

export type LowCommitOomVerdict = {
  /** Pre-gone MEMORYSTATUSEX.ullAvailPageFile, i.e. commit still available. */
  availableCommitMB: number
  sincePreviousOomMs: number
}

export type LowCommitOomRecoveryGate = {
  /** Read at gone time; returns a verdict only when auto-reload would run straight back into the OOM. */
  assess: (details: Electron.RenderProcessGoneDetails, now: number) => LowCommitOomVerdict | null
  /** Call only once the death is actually recovered, so a skipped teardown OOM cannot start the repeat window. */
  recordRecoveredDeath: (details: Electron.RenderProcessGoneDetails, goneAt: number) => void
}

export function createLowCommitOomRecoveryGate(
  readPreGoneDetails: (
    now: number
  ) => Record<string, CrashReportDetailValue> = preGoneSystemMemoryDetails
): LowCommitOomRecoveryGate {
  let previousOomAt: number | null = null
  return {
    assess: (details, now) => {
      const previous = previousOomAt
      if (
        // Only win32 swapFree is available commit; elsewhere it is not a verdict.
        process.platform !== 'win32' ||
        details.reason !== 'oom' ||
        previous === null ||
        now - previous > LOW_COMMIT_REPEAT_OOM_WINDOW_MS
      ) {
        return null
      }
      const sample = readPreGoneDetails(now)
      const availableCommitMB = sample[`${SYSTEM_MEMORY_KEY_PREFIX}PreGoneSwapFreeMB`]
      const sampleAgeMs = sample[`${SYSTEM_MEMORY_KEY_PREFIX}PreGoneSampleAgeMs`]
      if (
        typeof availableCommitMB !== 'number' ||
        typeof sampleAgeMs !== 'number' ||
        sampleAgeMs > LOW_COMMIT_MAX_SAMPLE_AGE_MS ||
        // Why: a reading from before the previous OOM misses the commit that corpse released.
        sampleAgeMs >= now - previous ||
        availableCommitMB >= LOW_COMMIT_AVAILABLE_MB_THRESHOLD
      ) {
        return null
      }
      return { availableCommitMB, sincePreviousOomMs: now - previous }
    },
    recordRecoveredDeath: (details, goneAt) => {
      if (details.reason === 'oom') {
        previousOomAt = goneAt
      }
    }
  }
}
