import type { RemoveWorktreeResult } from '../../../../shared/worktree/create-types'
import { WORKTREE_REMOVAL_WAIT_LIMIT_MS } from '../../../../shared/worktree/removal'
import { settleBeforeDeadline } from '../../settle-before-deadline'

type WaitedRemoval = RemoveWorktreeResult & { warning?: string; waitExpired?: true }

/**
 * Bounds a caller-requested wait for the delete. Past the limit the removal keeps running and the
 * reply says so (`waitExpired`) instead of claiming it finished; a failure still rejects.
 */
export async function settleRemovalWithinWaitLimit(
  removal: Promise<RemoveWorktreeResult & { warning?: string }>,
  limitMs = WORKTREE_REMOVAL_WAIT_LIMIT_MS
): Promise<WaitedRemoval> {
  const expired = new Error('worktree removal wait expired')
  try {
    return await settleBeforeDeadline(() => removal, {}, Date.now() + limitMs, expired)
  } catch (error) {
    if (error !== expired) {
      throw error
    }
    return { removing: true, waitExpired: true }
  }
}
