import { useAppStore } from '@/store'
import type { WorkspaceCleanupCandidate } from '../../../../shared/workspace-cleanup'
import { prepareActiveWorktreeFocusAfterDelete } from '../sidebar/active-worktree-focus-after-delete'

/**
 * Captures, before a cleanup batch starts, whether it includes the workspace the user is in.
 * The returned committer runs after every row settles and focuses a sibling only once that
 * workspace is gone; rows still queued in the batch are never picked. Safe to call repeatedly.
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
  const commit = prepareActiveWorktreeFocusAfterDelete(activeWorktreeId)
  return () => {
    // Why: this runs inside the removal loop; a focus failure must not abort the remaining deletes.
    try {
      commit()
    } catch (error) {
      console.error('Workspace cleanup could not focus another workspace', error)
    }
  }
}
