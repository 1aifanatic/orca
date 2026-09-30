import type { Store } from '../../../persistence/loading-store/store'
import {
  markAllWorktreeMembershipsDirty,
  markWorktreeMembershipDirty
} from '../../../git/worktree-membership/worktree-membership-store'
import { registerWorktreeChangeInvalidator } from '../../worktree-change-invalidators'

/** Every worktree-change invalidation also lets the repo's membership model skip its read memo. */
export function registerWorktreeMembershipInvalidation(store: Store): () => void {
  return registerWorktreeChangeInvalidator((repoId) => {
    const repoPath = store.getRepo(repoId)?.path
    if (repoPath) {
      markWorktreeMembershipDirty(repoPath)
    } else {
      markAllWorktreeMembershipsDirty()
    }
  })
}
