import { getAllWorktreesFromState, getWorktreeOnHostFromState } from '@/store/selectors'
import type { AppState } from '@/store/types'
import { getWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'
import type { Worktree } from '../../../../shared/worktree/types'
import { getHoveredWorkspaceIdentity } from './hovered-workspace-delete'
import { getWorktreeLineageGroupKey } from './worktree-list/grouping/group-keys'
import {
  getHostScopedWorktreeLineageInputs,
  getProjectedWorktreeLineageChildrenByParentId,
  getWorktreeLineageAncestors
} from './worktree-lineage-projection'

type ChildWorkspacesToggleState = Pick<
  AppState,
  'activeWorkspaceExecutionHostId' | 'activeWorktreeId' | 'worktreeLineageById' | 'worktreesByRepo'
>
type HoverDocument = NonNullable<Parameters<typeof getHoveredWorkspaceIdentity>[0]>

function resolveTargetWorktree(
  state: ChildWorkspacesToggleState,
  doc: HoverDocument
): Worktree | undefined {
  const hovered = getHoveredWorkspaceIdentity(doc)
  if (hovered) {
    // Why: the card under the pointer wins over the active one, like the delete shortcut.
    return getAllWorktreesFromState(state).find(
      (worktree) =>
        worktree.id === hovered.workspaceId &&
        getWorktreeHostIdentity(worktree) === hovered.hostIdentity
    )
  }
  return state.activeWorktreeId
    ? getWorktreeOnHostFromState(
        state,
        state.activeWorktreeId,
        state.activeWorkspaceExecutionHostId ?? undefined
      )
    : undefined
}

/**
 * The sidebar collapse key the "Toggle Child Workspaces" shortcut flips: the
 * target's own children, or its parent's when the target is a leaf child.
 * Null when the target is in no lineage, so the chord falls through.
 */
export function resolveChildWorkspacesToggleGroupKey(
  state: ChildWorkspacesToggleState,
  doc: HoverDocument = document
): string | null {
  const target = resolveTargetWorktree(state, doc)
  if (!target || target.isArchived) {
    return null
  }
  // Why: the sidebar nests a child only under a parent on the same host, and archived rows never render.
  const worktrees = getAllWorktreesFromState(state).filter(
    (worktree) => worktree.hostId === target.hostId && !worktree.isArchived
  )
  const { worktreeMap, lineageById } = getHostScopedWorktreeLineageInputs(
    worktrees,
    state.worktreeLineageById,
    target.hostId
  )
  const children = getProjectedWorktreeLineageChildrenByParentId(lineageById, worktreeMap)
  if ((children.get(target.id)?.length ?? 0) > 0) {
    return getWorktreeLineageGroupKey(target)
  }
  const [parent] = getWorktreeLineageAncestors(target, lineageById, worktreeMap)
  return parent ? getWorktreeLineageGroupKey(parent) : null
}
