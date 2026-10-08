import {
  normalizeVisibleExecutionHostIds,
  type ExecutionHostId
} from '../../../src/shared/execution-host'
import type { Worktree } from './workspace-list-types'
import { resolveWorktreeHostId } from './worktree-host-context-labels'

/**
 * The hosts the desktop's sidebar shows, or null for all. One shown host is how the desktop
 * stores a single-host focus too, and the phone follows hidden hosts, not focus.
 */
export function readVisibleHostIds(
  value: readonly string[] | null | undefined
): ReadonlySet<ExecutionHostId> | null {
  const ids = normalizeVisibleExecutionHostIds(value)
  return ids && ids.length > 1 ? new Set(ids) : null
}

export function filterVisibleHostRows(
  rows: readonly Worktree[],
  visibleHostIds: ReadonlySet<ExecutionHostId> | null,
  repoHostIdByRepoId: ReadonlyMap<string, ExecutionHostId>
): Worktree[] {
  if (!visibleHostIds) {
    return [...rows]
  }
  return rows.filter((row) => visibleHostIds.has(resolveWorktreeHostId(row, repoHostIdByRepoId)))
}
