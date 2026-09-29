import { getRealHomeConfigTomlPath } from './codex-real-home-hooks-json'
import {
  grantManagedCodexHookTrust,
  type CodexManagedTrustGrantOutcome,
  type CodexManagedTrustGrantPlan
} from './codex-hook-trust-grant'
import type { RealHomeCodexHookSlotWrite } from './codex-real-home-hook-entry-plan'
import { withdrawUntrustedRealHomeWrites } from './codex-real-home-hook-withdrawal'
import {
  runExclusivelyForCodexTrustConfig,
  runOutsideCodexTrustConfigLanes
} from './codex-trust-config-mutation-queue'

// Why seconds: a background grant blocks no launch, and a long latch at boot
// keeps ~/.codex off its hooks long after the app-server recovers.
const CODEX_BACKGROUND_TRUST_GRANT_RETRY_INTERVAL_MS = 10_000
// Why: a host whose app-server never starts in time must not rewrite
// ~/.codex/hooks.json and start a 30 s session on every launch for good.
const TIMEOUTS_BEFORE_BACKOFF = 3
const TIMEOUT_BACKOFF_MS = [10_000, 60_000, 5 * 60_000]
// Why process-scoped: app start begins at zero, so a slow boot never latches.
let consecutiveTimeouts = 0

export type RealHomeBackgroundGrant = {
  plan: CodexManagedTrustGrantPlan
  writes: readonly RealHomeCodexHookSlotWrite[]
  command: string
}

type SettleLane = (lane: 'installed' | 'unavailable', retryAfterMs: number) => void

/**
 * Codex's approval of a real-home entry, off the launch path. On failure it
 * withdraws what that install added and is still unapproved.
 */
export function runRealHomeBackgroundGrant(
  grant: RealHomeBackgroundGrant,
  settle: SettleLane
): Promise<void> {
  // Why outside the caller's lane: the withdrawal takes the config.toml lane
  // itself once the install has released it, like any later writer.
  return runOutsideCodexTrustConfigLanes(async () => {
    const outcome = await grantManagedCodexHookTrust(grant.plan)
    if (outcome.lane === 'rpc') {
      consecutiveTimeouts = 0
      settle('installed', 0)
      return
    }
    // Why: an untrusted Orca entry surfaces as "Hooks need review". Withdraw only
    // what this install wrote, and only while it is still untrusted: another
    // Orca may have trusted the identical entry meanwhile.
    const withdrawn = await runExclusivelyForCodexTrustConfig(
      getRealHomeConfigTomlPath(),
      async () => withdrawUntrustedRealHomeWrites(grant.writes, grant.command)
    )
    const retryAfterMs = getInstallRetryAfterMs(outcome)
    settle('unavailable', retryAfterMs)
    console.warn(
      `[codex-real-home-hooks] Codex did not approve Orca's entry (${outcome.reason}); ` +
        `withdrew ${withdrawn} unapproved entr${withdrawn === 1 ? 'y' : 'ies'} this attempt added; ` +
        `managed lane kept, ${describeRetry(retryAfterMs)}`
    )
  }).catch((error: unknown) => {
    console.warn('[codex-real-home-hooks] background trust grant failed:', error)
    consecutiveTimeouts = 0
    settle('unavailable', Date.now() + CODEX_BACKGROUND_TRUST_GRANT_RETRY_INTERVAL_MS)
  })
}

function getInstallRetryAfterMs(
  grant: Extract<CodexManagedTrustGrantOutcome, { lane: 'fallback' }>
): number {
  if (
    grant.reason === 'unsupported' ||
    grant.reason === 'unsupported-cached' ||
    grant.reason === 'disabled'
  ) {
    return Number.POSITIVE_INFINITY
  }
  if (grant.errorClass !== 'timeout') {
    consecutiveTimeouts = 0
    return Date.now() + CODEX_BACKGROUND_TRUST_GRANT_RETRY_INTERVAL_MS
  }
  // Why: a slow cold start retries on the next launch instead of latching for minutes.
  consecutiveTimeouts += 1
  if (consecutiveTimeouts < TIMEOUTS_BEFORE_BACKOFF) {
    return 0
  }
  const step = Math.min(
    consecutiveTimeouts - TIMEOUTS_BEFORE_BACKOFF,
    TIMEOUT_BACKOFF_MS.length - 1
  )
  return Date.now() + TIMEOUT_BACKOFF_MS[step]
}

function describeRetry(retryAfterMs: number): string {
  if (retryAfterMs === Number.POSITIVE_INFINITY) {
    return 'not retrying'
  }
  const delayMs = retryAfterMs - Date.now()
  return delayMs > 0 ? `retrying in ${Math.ceil(delayMs / 1000)} s` : 'retrying on the next launch'
}

export const _internals = {
  resetTimeoutStreakForTesting(): void {
    consecutiveTimeouts = 0
  }
}
