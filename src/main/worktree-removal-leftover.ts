import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import type { RemoveWorktreeResult } from '../shared/worktree/create-types'
import type { GitWorktreeInfo } from '../shared/worktree/types'
import { listWorktreesStrict } from './git/worktree'
import { getErrorCode, normalizeLocalBranchRef } from './git/worktree-operation-options'
import { areWorktreePathsEqual } from './git/worktree-path-comparison'
import { CLIENT_REMOVAL_HOME } from './worktree-removal-home-guard'
import type { WorktreeRemovalRecord } from './worktree-removal-records'
import {
  failedWorktreeRemovals,
  persistWorktreeRemovalRecords,
  worktreeCheckoutExists
} from './worktree-removal-table'
import { canSafelyRemoveOrphanedWorktreeDirectory } from './worktree-removal-safety'

/**
 * Whether a checkout path Git no longer registers still holds the removed checkout's own leftover:
 * no `.git` (Git deleted it first), or a `.git` file naming the admin entry Git removed. Any other
 * `.git` is a different checkout created at the path since.
 */
export async function isUnregisteredRemovalLeftover(
  repoPath: string,
  worktreePath: string
): Promise<boolean> {
  try {
    await lstat(join(worktreePath, '.git'))
  } catch (error) {
    return getErrorCode(error) === 'ENOENT'
  }
  return canSafelyRemoveOrphanedWorktreeDirectory(worktreePath, repoPath, CLIENT_REMOVAL_HOME)
}

/** The refusal when the path no longer holds the removed checkout's own leftover. */
export function differentCheckoutAtPathError(worktreePath: string): Error {
  return new Error(
    `A different checkout is now at ${worktreePath}; Orca left it in place. Delete it again to remove it.`
  )
}

/** Whether a checkout Git registers is the one the removal was accepted for. */
export function isRecordedCheckout(
  worktree: Pick<GitWorktreeInfo, 'branch' | 'head'>,
  record: { branch: string; head: string }
): boolean {
  return (
    normalizeLocalBranchRef(worktree.branch) === record.branch &&
    (!record.head || worktree.head === record.head)
  )
}

/** Whether Git registers a checkout at the recorded path now. */
export async function isCheckoutRegistered(record: {
  repoPath: string
  worktreePath: string
}): Promise<boolean> {
  return (await listWorktreesStrict(record.repoPath)).some((worktree) =>
    areWorktreePathsEqual(worktree.path, record.worktreePath)
  )
}

/**
 * Whether a failed delete stays listed with its error: its leftover Git no longer registers, or,
 * for a delete resumed at startup, the recorded checkout Git still registers, since nobody waits on
 * that delete's reply to see the error.
 */
export async function keepsFailedRemovalRow(
  record: WorktreeRemovalRecord,
  resumed: boolean
): Promise<boolean> {
  if (!(await worktreeCheckoutExists(record.worktreePath))) {
    return false
  }
  try {
    const registered = (await listWorktreesStrict(record.repoPath)).find((worktree) =>
      areWorktreePathsEqual(worktree.path, record.worktreePath)
    )
    return registered
      ? resumed && isRecordedCheckout(registered, record)
      : await isUnregisteredRemovalLeftover(record.repoPath, record.worktreePath)
  } catch (error) {
    // Unknowable: the row stays however Git lists it, as before this record existed.
    console.warn(`[worktrees] could not list worktrees of ${record.repoPath}`, error)
    return false
  }
}

/**
 * The refusal for a folder Git no longer registers: Orca deletes a checkout only through Git, so
 * the user removes the folder, and the workspace ends once it is gone.
 */
export function unregisteredFolderRefusal(worktreePath: string): Error {
  return new Error(
    `Git no longer tracks ${worktreePath}, so Orca won't delete it. Remove the folder yourself; Orca removes this workspace once the folder is gone.`
  )
}

/** Refuses while anything is at a checkout path Git no longer registers. */
export async function assertUnregisteredCheckoutGone(worktreePath: string): Promise<void> {
  if (await worktreeCheckoutExists(worktreePath)) {
    throw unregisteredFolderRefusal(worktreePath)
  }
}

/**
 * Delete's choice for a workspace whose earlier delete failed, from Git's listing taken now: a
 * checkout Git registers at the path again is the normal delete's, so the failed record is dropped;
 * a folder Git does not register is refused, the record kept; with the folder gone, `retry` runs
 * or joins the recorded removal to finish the rest. True then.
 */
export async function retryFailedRemovalUnlessRegistered(
  worktreeId: string,
  worktreePath: string,
  registeredWorktrees: readonly Pick<GitWorktreeInfo, 'path'>[],
  retry: () => Promise<RemoveWorktreeResult> | undefined
): Promise<boolean> {
  if (registeredWorktrees.some((worktree) => areWorktreePathsEqual(worktree.path, worktreePath))) {
    if (failedWorktreeRemovals.delete(worktreeId)) {
      void persistWorktreeRemovalRecords()
    }
    return false
  }
  const failed = failedWorktreeRemovals.get(worktreeId)
  if (failed) {
    await assertUnregisteredCheckoutGone(failed.worktreePath)
  }
  return retry() !== undefined
}
