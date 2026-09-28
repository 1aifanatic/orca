import { useAppStore } from '@/store'
import type { WorkspaceCleanupCandidate } from '../../../../shared/workspace-cleanup'
import { prepareActiveWorktreeFocusAfterDelete } from '../sidebar/active-worktree-focus-after-delete'

/**
 * Captures, before a cleanup batch starts, whether it includes the workspace the user is in.
 * The returned committer runs after the batch settles and focuses a sibling only if that
 * workspace is gone, matching the sidebar's batch delete. Safe to call more than once.
 */
export function prepareWorkspaceCleanupActiveWorkspaceFocus(
  candidates: readonly Pick<WorkspaceCleanupCandidate, 'worktreeId'>[]
): () => void {
  const activeWorktreeId = useAppStore.getState().activeWorktreeId
  if (
    !activeWorktreeId ||
    !candidates.some((candidate) => candidate.worktreeId === activeWorktreeId)
  ) {
    return () => {}
  }
  return prepareActiveWorktreeFocusAfterDelete(activeWorktreeId)
}
