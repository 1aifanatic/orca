import type { HostedReviewState } from './hosted-review'
import type { CheckStatus } from './github/pull-request-types'

export const MERGED_REVIEW_REFRESH_INTERVAL_MS = 24 * 60 * 60_000
export const CLOSED_REVIEW_REFRESH_INTERVAL_MS = 30 * 60_000

export function finishedReviewRefreshIntervalMs(
  state: HostedReviewState | null | undefined,
  status: CheckStatus | null | undefined
): number | null {
  // Checks can finish after merge; keep watching until they settle.
  if (state === 'merged') {
    return status === 'pending' ? 90_000 : MERGED_REVIEW_REFRESH_INTERVAL_MS
  }
  return state === 'closed' ? CLOSED_REVIEW_REFRESH_INTERVAL_MS : null
}
