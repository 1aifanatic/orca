import { useAppStore } from '@/store'
import { getWorktreeMapFromState } from '@/store/selectors'
import type { WorkspaceCleanupCandidate } from '../../../../shared/workspace-cleanup'
import { prepareActiveWorktreeFocusAfterDelete } from '../sidebar/active-worktree-focus-after-delete'

/**
 * Captures, before a cleanup batch starts, whether it includes the workspace the user is in.
 * The returned committer runs after every row settles and focuses a sibling only once that
 * workspace is gone and nothing else took focus; rows still queued in the batch are never
 * picked. Safe to call repeatedly.
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
  // The active row, then each successor picked here; only its removal may move focus.
  let focusedWorktreeId: string | null = activeWorktreeId
  let commit = prepareActiveWorktreeFocusAfterDelete(activeWorktreeId)
  return () => {
    // Why: this runs inside the removal loop; a focus failure must not abort the remaining deletes.
    try {
      const state = useAppStore.getState()
      // Why: an empty screen the user chose (e.g. closing the last tab) is not a deletion to repair.
      if (!focusedWorktreeId || getWorktreeMapFromState(state).has(focusedWorktreeId)) {
        return
      }
      if (state.activeWorktreeId !== null) {
        focusedWorktreeId = null
        return
      }
      commit()
      const successorId = useAppStore.getState().activeWorktreeId
      if (successorId) {
        focusedWorktreeId = successorId
        commit = prepareActiveWorktreeFocusAfterDelete(successorId)
      }
    } catch (error) {
      console.error('Workspace cleanup could not focus another workspace', error)
    }
  }
}
