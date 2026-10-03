import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../shared/execution-host'
import type { GitWorktreeInfo } from '../shared/worktree/types'
import { areWorktreePathsEqual } from './git/worktree-path-comparison'
import { isCheckoutRegistered, isUnregisteredRemovalLeftover } from './worktree-removal-leftover'
import type { WorktreeRemovalRecord } from './worktree-removal-records'
import {
  endUnfinishedWorktreeRemoval,
  failedWorktreeRemovals,
  finishedWorktreeRemovals,
  pendingWorktreeRemovals,
  persistWorktreeRemovalRecords,
  worktreeCheckoutExists
} from './worktree-removal-table'

/** The removals pending when a listing began to read Git. */
export type PendingWorktreeRemovals = ReadonlyMap<string, WorktreeRemovalRecord>

const NO_PENDING_REMOVALS: PendingWorktreeRemovals = new Map()

/**
 * Git's rows for a local repo plus one for each removal this host still owns whose checkout Git no
 * longer lists but is still on disk: a failed delete (carrying its error) or one still finishing.
 * A failed delete ends here, with its workspace, once its checkout is gone or a different folder
 * took the path.
 */
export async function withUnregisteredRemovalCheckouts(
  repoId: string,
  gitWorktrees: GitWorktreeInfo[]
): Promise<GitWorktreeInfo[]> {
  const unlisted = [...pendingWorktreeRemovals.values(), ...failedWorktreeRemovals.values()].filter(
    (record) =>
      record.repoId === repoId &&
      !gitWorktrees.some((worktree) => areWorktreePathsEqual(worktree.path, record.worktreePath))
  )
  if (unlisted.length === 0) {
    return gitWorktrees
  }
  const leftovers: GitWorktreeInfo[] = []
  const ended: WorktreeRemovalRecord[] = []
  for (const record of unlisted) {
    const failed = failedWorktreeRemovals.get(record.worktreeId) === record
    if (
      (await worktreeCheckoutExists(record.worktreePath)) &&
      (!failed || (await isUnregisteredRemovalLeftover(record)))
    ) {
      leftovers.push({
        path: record.worktreePath,
        head: record.head,
        branch: record.branch ? `refs/heads/${record.branch}` : '',
        isBare: false,
        isMainWorktree: false,
        ...(record.failure ? { removalError: record.failure.message } : {})
      })
    } else if (failedWorktreeRemovals.get(record.worktreeId) === record) {
      // Read again, not `failed`: a Delete may have retried it while this listing read the disk.
      failedWorktreeRemovals.delete(record.worktreeId)
      ended.push(record)
    }
  }
  if (ended.length > 0) {
    void persistWorktreeRemovalRecords()
  }
  for (const record of ended) {
    // Why ask Git again: the rows may be a cached scan, and a checkout Git registers at the path
    // since is a new workspace. Unknowable keeps it.
    if (!(await isCheckoutRegistered(record).catch(() => true))) {
      endUnfinishedWorktreeRemoval(record)
    }
  }
  return leftovers.length === 0 ? gitWorktrees : [...gitWorktrees, ...leftovers]
}

/**
 * What a failed delete left at its path: `leftover`, the accepted checkout Git no longer
 * registers; `unregistered`, nothing Git registers and no leftover (a different folder, or none);
 * `registered`, a checkout Git still registers, or no answer.
 */
export async function checkoutLeftByFailedRemoval(
  record: WorktreeRemovalRecord
): Promise<'leftover' | 'unregistered' | 'registered'> {
  try {
    if (await isCheckoutRegistered(record)) {
      return 'registered'
    }
    return (await worktreeCheckoutExists(record.worktreePath)) &&
      (await isUnregisteredRemovalLeftover(record))
      ? 'leftover'
      : 'unregistered'
  } catch (error) {
    // Unknowable: the row stays however Git lists it, as before this record existed.
    console.warn(`[worktrees] could not list worktrees of ${record.repoPath}`, error)
    return 'registered'
  }
}

/** Taken before a listing reads Git; pass it to projectPendingWorktreeRemovals with the rows. */
export function snapshotPendingWorktreeRemovals(): PendingWorktreeRemovals {
  return pendingWorktreeRemovals.size === 0 ? NO_PENDING_REMOVALS : new Map(pendingWorktreeRemovals)
}

/**
 * Marks rows whose checkout this host is deleting, or leaves them out for a client that cannot
 * read the marker: such a client already dropped the row on acceptance and would re-show it.
 */
export function projectPendingWorktreeRemovals<
  T extends { hostId?: ExecutionHostId; removing?: true }
>(
  rows: T[],
  idOf: (row: T) => string,
  clientReadsMarker: boolean,
  pendingAtScan: PendingWorktreeRemovals
): T[] {
  if (pendingWorktreeRemovals.size === 0 && pendingAtScan.size === 0) {
    return rows
  }
  const projected: T[] = []
  for (const row of rows) {
    const id = idOf(row)
    const local = row.hostId === undefined || row.hostId === LOCAL_EXECUTION_HOST_ID
    if (local && pendingWorktreeRemovals.has(id)) {
      if (clientReadsMarker) {
        projected.push({ ...row, removing: true })
      }
      continue
    }
    const scanned = local ? pendingAtScan.get(id) : undefined
    // Why: Git was read before this delete finished; unmarked, the gone row reads as a failed delete.
    if (!scanned || !finishedWorktreeRemovals.has(scanned)) {
      projected.push(row)
    }
  }
  return projected
}
