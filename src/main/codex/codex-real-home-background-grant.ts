import { getRealHomeConfigTomlPath } from './codex-real-home-hooks-json'
import {
  CODEX_TRUST_GRANT_TRANSIENT_RETRY_INTERVAL_MS,
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
  // Why outside the caller's lane: the grant takes the config.toml lane itself
  // once the install has released it, like any later writer.
  return runOutsideCodexTrustConfigLanes(async () => {
    const outcome = await grantManagedCodexHookTrust(grant.plan)
    if (outcome.lane === 'rpc') {
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
    settle('unavailable', Date.now() + CODEX_TRUST_GRANT_TRANSIENT_RETRY_INTERVAL_MS)
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
  // Why: a slow cold start retries on the next launch instead of latching for minutes.
  return grant.errorClass === 'timeout'
    ? 0
    : Date.now() + CODEX_TRUST_GRANT_TRANSIENT_RETRY_INTERVAL_MS
}

function describeRetry(retryAfterMs: number): string {
  if (retryAfterMs === Number.POSITIVE_INFINITY) {
    return 'not retrying'
  }
  const delayMs = retryAfterMs - Date.now()
  return delayMs > 0 ? `retrying in ${Math.ceil(delayMs / 1000)} s` : 'retrying on the next launch'
}
