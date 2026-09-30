import { useAppStore } from '@/store'
import type { Worktree } from '../../../../shared/worktree/types'

/**
 * Drops a row's stale delete state before a new attempt, or when its Delete dialog closes. A failed
 * delete the host still lists stays shown: it clears once the retry starts or the host drops it.
 */
export function resetWorktreeDeleteState(
  target: Pick<Worktree, 'id' | 'hostId'>,
  row: Pick<Worktree, 'removalError'> | null | undefined
): void {
  if (row?.removalError) {
    return
  }
  const state = useAppStore.getState()
  if (target.hostId) {
    state.clearWorktreeDeleteState(target.id, target.hostId)
  } else {
    state.clearWorktreeDeleteState(target.id)
  }
}
