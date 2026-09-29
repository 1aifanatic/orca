import type { ExecutionHostId } from '../../../../shared/execution-host'
import { getRepoIdFromWorktreeId } from '../../../../shared/worktree/id'
import type { WorktreeRemovalOutcome } from '../../../../shared/worktree/removal-outcome'
import type { Worktree } from '../../../../shared/worktree/types'
import { getWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'
import { getDeleteStateForWorktreeHost } from '@/components/sidebar/worktree-delete-state-host-match'
import { useAppStore } from '../../store'
import type { AppState } from '../../store/types'
import {
  rowHostId,
  setBackgroundWorktreeRemovalRowsLookup,
  settleBackgroundWorktreeRemoval,
  settleBackgroundWorktreeRemovalsFromRows
} from '../../store/slices/worktrees/teardown/background-worktree-removal'

type HostMarkedRow = Pick<Worktree, 'id' | 'hostId'>
type AppStoreApi = Pick<typeof useAppStore, 'getState' | 'setState'>

// Delete states this bridge set from a host marker, keyed like deleteStateByWorktreeId. A state the
// local delete flow set is left to that flow.
const hostMarkedDeleteStates = new Map<string, HostMarkedRow>()

function deleteStateKey(row: HostMarkedRow): string {
  return row.hostId ? getWorktreeHostIdentity(row) : row.id
}

function rowsForWorktree(state: AppState, worktreeId: string): Worktree[] {
  const repoId = getRepoIdFromWorktreeId(worktreeId)
  return [
    ...(state.worktreesByRepo[repoId] ?? []),
    ...(state.detectedWorktreesByRepo[repoId]?.worktrees ?? [])
  ]
}

/** Keeps the existing Deleting card state set while the host lists a row as removing. */
export function reconcileHostWorktreeRemovals(store: AppStoreApi = useAppStore): void {
  const state = store.getState()
  settleBackgroundWorktreeRemovalsFromRows((worktreeId) => rowsForWorktree(state, worktreeId))
  const marked: HostMarkedRow[] = []
  const seen = new Set<string>()
  for (const rows of Object.values(state.worktreesByRepo)) {
    for (const row of rows) {
      if (!row.removing) {
        continue
      }
      const key = deleteStateKey(row)
      seen.add(key)
      if (hostMarkedDeleteStates.has(key)) {
        continue
      }
      const current = getDeleteStateForWorktreeHost(row, state.deleteStateByWorktreeId)
      if (current?.isDeleting && current.phase !== 'queued') {
        continue
      }
      hostMarkedDeleteStates.set(key, { id: row.id, hostId: row.hostId })
      marked.push({ id: row.id, hostId: row.hostId })
    }
  }
  if (marked.length > 0) {
    state.markWorktreesDeleting(marked)
  }
  for (const [key, row] of hostMarkedDeleteStates) {
    if (seen.has(key)) {
      continue
    }
    hostMarkedDeleteStates.delete(key)
    if (store.getState().deleteStateByWorktreeId[key]?.isDeleting) {
      store.getState().clearWorktreeDeleteState(row.id, row.hostId)
    }
  }
}

/** Routes a host's removal outcome to the delete that asked for it, or onto a host-marked card. */
export function applyBackgroundWorktreeRemovalOutcome(
  hostId: ExecutionHostId,
  outcome: WorktreeRemovalOutcome,
  store: AppStoreApi = useAppStore
): void {
  if (settleBackgroundWorktreeRemoval(hostId, outcome) || outcome.status !== 'failed') {
    return
  }
  for (const [key, row] of hostMarkedDeleteStates) {
    if (row.id !== outcome.worktreeId || rowHostId(row) !== hostId) {
      continue
    }
    hostMarkedDeleteStates.delete(key)
    store.setState((s) => ({
      deleteStateByWorktreeId: {
        ...s.deleteStateByWorktreeId,
        [key]: {
          isDeleting: false,
          ...(row.hostId ? { executionHostId: row.hostId } : {}),
          error: outcome.error,
          canForceDelete: false,
          forceDeleteReason: null
        }
      }
    }))
  }
}

export function registerBackgroundWorktreeRemovalBridge(unsubs: (() => void)[]): void {
  setBackgroundWorktreeRemovalRowsLookup((worktreeId) =>
    rowsForWorktree(useAppStore.getState(), worktreeId)
  )
  unsubs.push(() => setBackgroundWorktreeRemovalRowsLookup(null))
  let previousRows = useAppStore.getState().worktreesByRepo
  let previousDetected = useAppStore.getState().detectedWorktreesByRepo
  unsubs.push(
    useAppStore.subscribe((state) => {
      if (
        state.worktreesByRepo === previousRows &&
        state.detectedWorktreesByRepo === previousDetected
      ) {
        return
      }
      previousRows = state.worktreesByRepo
      previousDetected = state.detectedWorktreesByRepo
      reconcileHostWorktreeRemovals()
    })
  )
}

export function _resetBackgroundWorktreeRemovalBridgeForTests(): void {
  hostMarkedDeleteStates.clear()
}
