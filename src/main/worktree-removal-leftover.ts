import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { listWorktreesStrict } from './git/worktree'
import { getErrorCode } from './git/worktree-operation-options'
import { areWorktreePathsEqual } from './git/worktree-path-comparison'
import { CLIENT_REMOVAL_HOME } from './worktree-removal-home-guard'
import {
  assertWorktreeDoesNotContainRegisteredWorktree,
  canSafelyRemoveOrphanedWorktreeDirectory
} from './worktree-removal-safety'
import type { GitWorktreeExecOptions } from './git/worktree-operation-options'
import { matchCheckoutDirectory } from './worktree-checkout-identity'
import type { WorktreeRemovalRecord } from './worktree-removal-records'

type RemovalLeftoverRecord = Pick<
  WorktreeRemovalRecord,
  'repoPath' | 'worktreePath' | 'checkoutIdentity'
>

/**
 * Whether a checkout path Git no longer registers still holds the removed checkout's own leftover:
 * the very directory the removal accepted (or nothing at all), with no `.git` (Git deleted it first)
 * or a `.git` file naming the admin entry Git removed. Anything else was put at the path since,
 * unless the path could not be read, which proves neither.
 */
export async function unregisteredRemovalLeftoverVerdict(
  record: RemovalLeftoverRecord
): Promise<'leftover' | 'unreadable' | 'different-folder' | 'different-checkout'> {
  const match = await matchCheckoutDirectory(record.worktreePath, record.checkoutIdentity)
  if (match === 'absent') {
    return 'leftover'
  }
  if (match === 'unreadable') {
    return 'unreadable'
  }
  if (match !== 'same') {
    return 'different-folder'
  }
  try {
    await lstat(join(record.worktreePath, '.git'))
  } catch (error) {
    return getErrorCode(error) === 'ENOENT' ? 'leftover' : 'unreadable'
  }
  return (await canSafelyRemoveOrphanedWorktreeDirectory(
    record.worktreePath,
    record.repoPath,
    CLIENT_REMOVAL_HOME
  ))
    ? 'leftover'
    : 'different-checkout'
}

/** The refusal when the path no longer holds the removed checkout's own leftover. */
export function differentCheckoutAtPathError(worktreePath: string): Error {
  return new Error(
    `A different checkout is now at ${worktreePath}; Orca left it in place. Delete it again to remove it.`
  )
}

/** The refusal when the folder at the path is not the one Orca started deleting. */
export function differentFolderAtPathError(worktreePath: string): Error {
  return new Error(
    `The folder at ${worktreePath} is not the one Orca started deleting, so Orca left it in place.`
  )
}

/** The refusal when the path could not be read, so nothing proves it holds the accepted folder. */
export function unreadableFolderAtPathError(worktreePath: string): Error {
  return new Error(
    `Orca could not read the folder at ${worktreePath}, so Orca left it in place. Delete it again once it can be read.`
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
 * Refuses unless the path still holds the removed checkout's own leftover, with no worktree Git
 * registers at or inside it. Run right before the delete: the path can change while it waits.
 */
export async function assertUnregisteredRemovalLeftover(
  record: RemovalLeftoverRecord,
  options: GitWorktreeExecOptions = {}
): Promise<void> {
  const { repoPath, worktreePath } = record
  const worktrees = await listWorktreesStrict(repoPath, options)
  if (worktrees.some((worktree) => areWorktreePathsEqual(worktree.path, worktreePath))) {
    throw differentCheckoutAtPathError(worktreePath)
  }
  assertWorktreeDoesNotContainRegisteredWorktree(worktreePath, worktrees)
  const verdict = await unregisteredRemovalLeftoverVerdict(record)
  if (verdict === 'unreadable') {
    throw unreadableFolderAtPathError(worktreePath)
  }
  if (verdict === 'different-folder') {
    throw differentFolderAtPathError(worktreePath)
  }
  if (verdict === 'different-checkout') {
    throw differentCheckoutAtPathError(worktreePath)
  }
}
