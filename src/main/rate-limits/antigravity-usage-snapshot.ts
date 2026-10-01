import type { ProviderRateLimits } from '../../shared/rate-limit-types'
/**
 * What the provider reports when the user is not showing Antigravity usage at all.
 *
 * Why a snapshot rather than leaving the slot null: the state shape is published to every reader
 * (status bar, Accounts, mobile), and an absent entry reads as "still loading" instead of
 * "switched off".
 */
export function antigravityUsageDisabledSnapshot(now: number = Date.now()): ProviderRateLimits {
  return {
    provider: 'antigravity',
    session: null,
    weekly: null,
    updatedAt: now,
    error: null,
    status: 'idle'
  }
}
