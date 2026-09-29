import { useAppStore } from '@/store'
import { getRepoMapFromState, getWorktreeOnHostFromState } from '@/store/selectors'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { isRuntimeOwnedSshTargetId, parseExecutionHostId } from '../../../shared/execution-host'
import type { Repo } from '../../../shared/repo-types'
import type { Worktree } from '../../../shared/worktree/types'
import { getWorktreeVisitTimestamp } from '@/lib/worktree-visit-recency'
import { collectLeavingWorktreeIds } from '@/store/slices/worktrees/teardown/worktree-delete-state'

type AppStoreState = ReturnType<typeof useAppStore.getState>

type RemovedActiveWorktree = { worktreeId: string; repoId: string }

// Why: a per-workspace-env's runtime-owned SSH target is torn down when the workspace is deleted,
// so re-focusing a sibling hosted on that same target would land on a dead runtime and auto-create
// a terminal that can never spawn (a blank, stuck pane). Treat such siblings as not focus-eligible.
function isHostedOnRuntimeOwnedSshTarget(
  worktree: Pick<Worktree, 'hostId' | 'repoId'>,
  repoById: Map<string, Repo>
): boolean {
  const hostIds = [
    worktree.hostId,
    repoById.get(worktree.repoId)?.executionHostId,
    repoById.get(worktree.repoId)?.connectionId
  ]
  return hostIds.some((value) => {
    if (!value) {
      return false
    }
    // connectionId is a raw target id; executionHostId/hostId are `ssh:<targetId>`.
    if (isRuntimeOwnedSshTargetId(value)) {
      return true
    }
    const parsed = parseExecutionHostId(value)
    return parsed?.kind === 'ssh' && isRuntimeOwnedSshTargetId(parsed.targetId)
  })
}

// Why: removing the workspace the user is viewing should behave like closing a tab — prefer
// another non-base/primary workspace of the same project (most-recently-visited first), and
// fall back to the project's base/primary workspace when no other workspace remains.
function pickSuccessorWorktree(
  state: AppStoreState,
  repoId: string,
  removedWorktreeId: string
): Worktree | null {
  // Skipping a row that may be leaving is always safe; the next sibling or main takes its place.
  const leavingIds = collectLeavingWorktreeIds(state.deleteStateByWorktreeId)
  const repoById = getRepoMapFromState(state)
  const siblings = (state.worktreesByRepo[repoId] ?? []).filter(
    (worktree) =>
      worktree.id !== removedWorktreeId &&
      !leavingIds.has(worktree.id) &&
      !isHostedOnRuntimeOwnedSshTarget(worktree, repoById)
  )
  const others = siblings.filter((worktree) => !worktree.isMainWorktree)
  if (others.length > 0) {
    const lastVisited = state.lastVisitedAtByWorktreeId
    const [mostRecent] = [...others].sort(
      (a, b) =>
        (getWorktreeVisitTimestamp(lastVisited, b) ?? 0) -
        (getWorktreeVisitTimestamp(lastVisited, a) ?? 0)
    )
    return mostRecent
  }
  return siblings.find((worktree) => worktree.isMainWorktree) ?? null
}

function countRowsWithId(rows: readonly Worktree[] | undefined, worktreeId: string): number {
  return rows?.reduce((count, row) => (row.id === worktreeId ? count + 1 : count), 0) ?? 0
}

/** The last-viewed workspace, when this update removed its row. */
function findRemovedWorktree(
  state: AppStoreState,
  previous: AppStoreState,
  worktreeId: string
): RemovedActiveWorktree | null {
  // Folder workspaces have no row here, and no sibling to hand focus to.
  const removedRow = getWorktreeOnHostFromState(previous, worktreeId, undefined)
  if (!removedRow) {
    return null
  }
  const { repoId } = removedRow
  return countRowsWithId(state.worktreesByRepo[repoId], worktreeId) <
    countRowsWithId(previous.worktreesByRepo[repoId], worktreeId)
    ? { worktreeId, repoId }
    : null
}

function focusSuccessor(removed: RemovedActiveWorktree): void {
  const state = useAppStore.getState()
  // Why: a navigation that landed after the removal owns the selection.
  if (
    state.activeView !== 'terminal' ||
    state.activePendingCreationId !== null ||
    state.activeWorktreeId !== null
  ) {
    return
  }
  const successor = pickSuccessorWorktree(state, removed.repoId, removed.worktreeId)
  if (successor) {
    // Keep successor focus from replacing the removed row's spatial context.
    activateAndRevealWorktree(successor.id, {
      revealInSidebar: false,
      ...(successor.hostId ? { executionHostId: successor.hostId } : {})
    })
  }
}

/**
 * Every path that removes the workspace the user is viewing — an in-Orca delete, a delete that
 * failed after git dropped the worktree, `git worktree remove`, the CLI, another client — ends in
 * a store update that drops its row. This hands focus to a sibling at that one point, so no
 * removal path has to remember to do it.
 */
export function installActiveWorktreeRemovalHandoff(): () => void {
  // Why remembered rather than read from the previous state: removal stops the workspace's
  // shells, and closing its last tab can empty the selection before the row leaves.
  let lastViewedWorktreeId = useAppStore.getState().activeWorktreeId
  return useAppStore.subscribe((state, previous) => {
    if (state.activeWorktreeId !== null) {
      lastViewedWorktreeId = state.activeWorktreeId
      return
    }
    if (lastViewedWorktreeId === null || state.worktreesByRepo === previous.worktreesByRepo) {
      return
    }
    const removed = findRemovedWorktree(state, previous, lastViewedWorktreeId)
    if (!removed) {
      return
    }
    lastViewedWorktreeId = null
    // Top-level views and the creation panel keep a workspace id without showing it.
    if (state.activeView !== 'terminal' || state.activePendingCreationId !== null) {
      return
    }
    // Why deferred: activating re-enters the store mid-notification, and a caller that
    // navigates synchronously right after the removal must win.
    queueMicrotask(() => focusSuccessor(removed))
  })
}
