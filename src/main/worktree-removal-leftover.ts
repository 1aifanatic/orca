import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { getErrorCode } from './git/worktree-operation-options'
import { CLIENT_REMOVAL_HOME } from './worktree-removal-home-guard'
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
