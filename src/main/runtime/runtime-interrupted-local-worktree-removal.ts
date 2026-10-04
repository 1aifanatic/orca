import type { RemoveWorktreeResult } from '../../shared/worktree/create-types'
import type { GitWorktreeInfo } from '../../shared/worktree/types'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import type { Store } from '../persistence'
import {
  releaseStartupRemovalFence,
  type BackgroundWorktreeRemovalJob
} from '../worktree-background-removal'
import { resolveWorktreeRemovalMetadata } from '../worktree-removal-repo-owner'
import type { RuntimePreservedBranchCleanup } from './runtime-preserved-branch-cleanup'
import { listWorktreesStrict } from '../git/worktree'
import { finishUnregisteredWorktreeRemoval } from '../git/worktree-removal'
import { normalizeLocalBranchRef } from '../git/worktree-operation-options'
import { areWorktreePathsEqual } from '../git/worktree-path-comparison'
import { getLocalProjectWorktreeGitOptions } from '../project-runtime-git-options'
import { findRegisteredDeletableWorktree } from '../worktree-removal-safety'
import {
  assertUnregisteredCheckoutGone,
  differentCheckoutAtPathError
} from '../worktree-removal-leftover'
import { CLIENT_REMOVAL_HOME } from '../worktree-removal-home-guard'
import type { WorktreeRemovalRecord } from '../worktree-removal-records'
import {
  cleanupRemovedWorktreePushTarget,
  finishRuntimeLocalWorktreeRemoval,
  type RuntimeLocalWorktreeRemovalFinishArgs
} from './runtime-registered-local-worktree-removal'

type InterruptedWorktreeRemovalHost = {
  store: Store
  acquireWatcherRemoval: (path: string) => Promise<{ finish: (removed: boolean) => Promise<void> }>
  closeWatchers: (path: string) => Promise<void>
  preservedBranchCleanup: Pick<RuntimePreservedBranchCleanup, 'preserveHead' | 'remember'>
  /** A retry's teardown: terminals opened in the folder before the user removed it. */
  stopPtys?: () => Promise<void>
  /** Drops the worktree's host state (metadata, history, caches), as every removal path does. */
  purge: (record: WorktreeRemovalRecord) => void
  onRemoved: (record: WorktreeRemovalRecord) => void
  publish: (repoId: string) => void
}

/** The background job that finishes one interrupted removal on this host. */
export function interruptedLocalWorktreeRemovalJob(
  record: WorktreeRemovalRecord,
  host: InterruptedWorktreeRemovalHost
): BackgroundWorktreeRemovalJob {
  return {
    run: async (stopSignal) => {
      const removedPushTarget = resolveWorktreeRemovalMetadata(
        host.store,
        record.repoId,
        record.worktreeId,
        LOCAL_EXECUTION_HOST_ID
      )?.pushTarget
      const result = await finishInterruptedLocalWorktreeRemoval({
        record,
        store: host.store,
        stopSignal,
        removedPushTarget,
        acquireWatcherRemoval: (path) => {
          // Why same tick: the gate takes over the loading fence's path with no gap for a spawn.
          releaseStartupRemovalFence(record.worktreeId)
          return host.acquireWatcherRemoval(path)
        },
        closeWatchers: host.closeWatchers,
        stopPtys: host.stopPtys,
        preserveBranchHead: (result, fallbackHead) =>
          host.preservedBranchCleanup.preserveHead(result, fallbackHead),
        // remember() clears the cleanup target when no branch was preserved.
        finishRemoval: (result, _rememberBranch, fallbackHead) => {
          host.preservedBranchCleanup.remember(
            record.worktreeId,
            undefined,
            result,
            fallbackHead,
            removedPushTarget
          )
          host.purge(record)
        }
      })
      host.onRemoved(record)
      return result
    },
    publish: () => host.publish(record.repoId)
  }
}

type InterruptedLocalWorktreeRemovalArgs = Pick<
  RuntimeLocalWorktreeRemovalFinishArgs,
  'removedPushTarget' | 'closeWatchers' | 'preserveBranchHead' | 'finishRemoval'
> & {
  store: Store
  record: WorktreeRemovalRecord
  acquireWatcherRemoval: (path: string) => Promise<{ finish: (removed: boolean) => Promise<void> }>
  stopPtys?: () => Promise<void>
  stopSignal: AbortSignal
}

/**
 * Finishes a removal a quit or crash interrupted, or a failed one whose folder the user removed.
 * What is left comes from Git and disk, not the record: a checkout Git registers is deleted by Git
 * with the recorded choices; a folder Git no longer registers is refused, never deleted; with the
 * folder gone, the rest of the delete finishes.
 */
async function finishInterruptedLocalWorktreeRemoval(
  args: InterruptedLocalWorktreeRemovalArgs
): Promise<RemoveWorktreeResult> {
  const { record, store } = args
  const repo = store.getRepo(record.repoId)
  if (!repo) {
    console.warn(`[worktrees] dropping removal of ${record.worktreePath}: its repo is gone`)
    return {}
  }
  const localOptions = getLocalProjectWorktreeGitOptions(store, repo)
  const finishArgs: RuntimeLocalWorktreeRemovalFinishArgs = {
    store,
    removedPushTarget: args.removedPushTarget,
    closeWatchers: args.closeWatchers,
    preserveBranchHead: args.preserveBranchHead,
    finishRemoval: args.finishRemoval,
    repo,
    localOptions,
    force: record.force,
    deleteBranch: record.deleteBranch,
    target: { id: record.worktreeId }
  }
  const worktrees = await listWorktreesStrict(repo.path, localOptions)
  const registered = worktrees.some((worktree) =>
    areWorktreePathsEqual(worktree.path, record.worktreePath)
  )
  const deletable = registered
    ? findRegisteredDeletableWorktree(
        repo.path,
        record.worktreePath,
        worktrees,
        CLIENT_REMOVAL_HOME
      )
    : undefined
  if (registered && !deletable) {
    throw new Error(
      `Worktree registration changed during deletion: ${record.worktreePath}. Retry deletion.`
    )
  }
  if (deletable && !isRecordedCheckout(deletable, record)) {
    throw differentCheckoutAtPathError(record.worktreePath)
  }
  // Before the teardown, so a refused folder keeps its terminals and watchers.
  if (!deletable) {
    await assertUnregisteredCheckoutGone(record.worktreePath)
  }
  const gate = await args.acquireWatcherRemoval(record.worktreePath)
  if (args.stopPtys) {
    try {
      await args.stopPtys()
    } catch (error) {
      await gate.finish(false)
      throw error
    }
  }
  if (deletable) {
    return finishRuntimeLocalWorktreeRemoval(finishArgs, deletable, gate, args.stopSignal)
  }
  let result: RemoveWorktreeResult
  let removed = false
  try {
    result = await finishUnregisteredWorktreeRemoval(
      repo.path,
      record.worktreePath,
      record.deleteBranch && record.branch ? { name: record.branch, head: record.head } : null,
      // Again after the teardown's waits: a folder may have appeared at the path meanwhile.
      () => assertUnregisteredCheckoutGone(record.worktreePath),
      localOptions
    )
    removed = true
  } finally {
    await gate.finish(removed)
  }
  await cleanupRemovedWorktreePushTarget(finishArgs)
  args.finishRemoval(result, true, record.head)
  return result
}

function isRecordedCheckout(worktree: GitWorktreeInfo, record: WorktreeRemovalRecord): boolean {
  return (
    normalizeLocalBranchRef(worktree.branch) === record.branch &&
    (!record.head || worktree.head === record.head)
  )
}
