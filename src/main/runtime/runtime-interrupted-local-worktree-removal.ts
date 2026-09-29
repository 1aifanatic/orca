import type { RemoveWorktreeResult } from '../../shared/worktree/create-types'
import type { WorktreeRemovalOutcome } from '../../shared/worktree/removal-outcome'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import type { Store } from '../persistence'
import { getLocalWorktreeCatalogVersion } from '../local-worktree-scan-generation'
import type { BackgroundWorktreeRemovalJob } from '../worktree-background-removal'
import { resolveWorktreeRemovalMetadata } from '../worktree-removal-repo-owner'
import type { RuntimePreservedBranchCleanup } from './runtime-preserved-branch-cleanup'
import { listWorktreesStrict } from '../git/worktree'
import { finishUnregisteredWorktreeRemoval } from '../git/worktree-removal'
import { areWorktreePathsEqual } from '../git/worktree-path-comparison'
import { getLocalProjectWorktreeGitOptions } from '../project-runtime-git-options'
import { findRegisteredDeletableWorktree } from '../worktree-removal-safety'
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
  /** Drops the worktree's host state (metadata, history, caches), as every removal path does. */
  purge: (record: WorktreeRemovalRecord) => void
  onRemoved: (record: WorktreeRemovalRecord) => void
  publish: (repoId: string, outcome?: WorktreeRemovalOutcome) => void
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
        acquireWatcherRemoval: host.acquireWatcherRemoval,
        closeWatchers: host.closeWatchers,
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
    catalogVersion: () => getLocalWorktreeCatalogVersion(record.repoId),
    publish: (outcome) => host.publish(record.repoId, outcome)
  }
}

type InterruptedLocalWorktreeRemovalArgs = Pick<
  RuntimeLocalWorktreeRemovalFinishArgs,
  'removedPushTarget' | 'closeWatchers' | 'preserveBranchHead' | 'finishRemoval'
> & {
  store: Store
  record: WorktreeRemovalRecord
  acquireWatcherRemoval: (path: string) => Promise<{ finish: (removed: boolean) => Promise<void> }>
  stopSignal: AbortSignal
}

/**
 * Finishes a removal a quit or crash interrupted. What is left comes from Git and disk, not the
 * record, so a delete Git already finished (fully or partly) completes the same way.
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
    // Why force: Git already deleted part of the checkout, which reads as local changes.
    force: true,
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
  const gate = await args.acquireWatcherRemoval(record.worktreePath)
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
