import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../shared/execution-host'
import type { RemoveWorktreeResult } from '../shared/worktree/create-types'
import type { WorktreeCatalogVersion } from '../shared/worktree/catalog-version'
import type { WorktreeRemovalOutcome } from '../shared/worktree/removal-outcome'
import { areWorktreePathsEqual } from './git/worktree-path-comparison'
import { parseWslPath } from './wsl'

export type PendingWorktreeRemoval = {
  worktreeId: string
  repoId: string
  repoPath: string
  worktreePath: string
  /** Short branch name the checkout had; empty when detached. */
  branch: string
}

// Why in memory only: after a crash Git still lists the checkout, so it returns as a normal row
// and a second remove finishes it. Nothing here outlives the process that runs the delete.
const pendingByWorktreeId = new Map<string, PendingWorktreeRemoval>()
const runningJobs = new Set<Promise<void>>()

/** Only this host's local checkouts are removed in the background. */
export function isWorktreeRemovalPending(worktreeId: string, hostId?: ExecutionHostId): boolean {
  return (hostId ?? LOCAL_EXECUTION_HOST_ID) === LOCAL_EXECUTION_HOST_ID
    ? pendingByWorktreeId.has(worktreeId)
    : false
}

/** WSL checkouts still delete inline, as before; moving them off the request is a follow-up. */
export function removesInBackground(
  worktreePath: string,
  options: { wslDistro?: string }
): boolean {
  return !options.wslDistro && !parseWslPath(worktreePath)
}

export function hasPendingWorktreeRemovals(): boolean {
  return pendingByWorktreeId.size > 0
}

export function findPendingWorktreeRemovalConflict(
  repoPath: string,
  target: { worktreePath?: string; branch?: string }
): PendingWorktreeRemoval | undefined {
  const branch = target.branch?.replace(/^refs\/heads\//, '')
  for (const removal of pendingByWorktreeId.values()) {
    if (!areWorktreePathsEqual(removal.repoPath, repoPath)) {
      continue
    }
    if (
      (target.worktreePath && areWorktreePathsEqual(removal.worktreePath, target.worktreePath)) ||
      (branch && removal.branch === branch)
    ) {
      return removal
    }
  }
  return undefined
}

export function assertNoPendingWorktreeRemovalConflict(
  repoPath: string,
  target: { worktreePath?: string; branch?: string }
): void {
  const removal = findPendingWorktreeRemovalConflict(repoPath, target)
  if (removal) {
    throw new Error(
      `Orca is still deleting the workspace at ${removal.worktreePath}. Cleanup is pending; try again shortly.`
    )
  }
}

/**
 * Records an accepted removal and runs its delete off the request. `publish` fires once when the
 * row starts showing as removing, and once with the outcome after the row has left the table.
 */
export function startBackgroundWorktreeRemoval(args: {
  removal: PendingWorktreeRemoval
  run: () => Promise<RemoveWorktreeResult>
  catalogVersion: () => WorktreeCatalogVersion
  publish: (outcome?: WorktreeRemovalOutcome) => void
}): void {
  const { removal } = args
  pendingByWorktreeId.set(removal.worktreeId, removal)
  const job = settleBackgroundWorktreeRemoval(args)
  runningJobs.add(job)
  void job.finally(() => runningJobs.delete(job))
  publishSafely(args.publish, undefined)
}

async function settleBackgroundWorktreeRemoval(
  args: Parameters<typeof startBackgroundWorktreeRemoval>[0]
): Promise<void> {
  const { removal } = args
  let outcome: WorktreeRemovalOutcome
  try {
    const result = await args.run()
    outcome = {
      worktreeId: removal.worktreeId,
      status: 'removed',
      ...(result.preservedBranch ? { preservedBranch: result.preservedBranch } : {}),
      catalogVersion: args.catalogVersion()
    }
  } catch (error) {
    console.warn(`[worktrees] background removal of ${removal.worktreePath} failed`, error)
    outcome = {
      worktreeId: removal.worktreeId,
      status: 'failed',
      error: error instanceof Error ? error.message : String(error)
    }
  }
  if (pendingByWorktreeId.get(removal.worktreeId) === removal) {
    pendingByWorktreeId.delete(removal.worktreeId)
  }
  publishSafely(args.publish, outcome)
}

function publishSafely(
  publish: (outcome?: WorktreeRemovalOutcome) => void,
  outcome: WorktreeRemovalOutcome | undefined
): void {
  try {
    publish(outcome)
  } catch (error) {
    // Why: a failed notification must not strand the table entry or reject the detached job.
    console.error('[worktrees] failed to publish background removal state', error)
  }
}

/**
 * Marks rows whose checkout this host is deleting, or leaves them out for a client that cannot
 * read the marker: such a client already dropped the row on acceptance and would re-show it.
 */
export function projectPendingWorktreeRemovals<
  T extends { hostId?: ExecutionHostId; removing?: true }
>(rows: T[], idOf: (row: T) => string, clientReadsMarker: boolean): T[] {
  if (pendingByWorktreeId.size === 0) {
    return rows
  }
  const projected: T[] = []
  for (const row of rows) {
    const pending =
      (row.hostId === undefined || row.hostId === LOCAL_EXECUTION_HOST_ID) &&
      pendingByWorktreeId.has(idOf(row))
    if (!pending) {
      projected.push(row)
    } else if (clientReadsMarker) {
      projected.push({ ...row, removing: true })
    }
  }
  return projected
}

export async function _settlePendingWorktreeRemovalsForTests(): Promise<void> {
  while (runningJobs.size > 0) {
    await Promise.all(runningJobs)
  }
}

export function _resetPendingWorktreeRemovalsForTests(): void {
  pendingByWorktreeId.clear()
  runningJobs.clear()
}
