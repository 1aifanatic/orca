import { lstat } from 'node:fs/promises'
import { getErrorCode } from './git/worktree-operation-options'

/**
 * The directory a removal accepted, by filesystem identity. A delete Orca finishes later (a retry
 * or a restart's resume) must only take that directory: a folder created at the same path since is
 * the user's, however much it looks like the leftover. Decimal strings keep 64-bit ids exact.
 */
export type CheckoutDirectoryIdentity = {
  dev: string
  ino: string
  /** Never `0`: without a creation time the directory is unidentifiable and nothing is recorded. */
  birthtimeNs: string
}

/** `absent`: nothing at the path. `unrecorded`: no identity was recorded, so nothing is provable. */
export type CheckoutDirectoryMatch = 'same' | 'different' | 'absent' | 'unrecorded'

async function statDirectory(path: string): Promise<CheckoutDirectoryIdentity | 'absent' | null> {
  try {
    const stats = await lstat(path, { bigint: true })
    if (!stats.isDirectory()) {
      return null
    }
    return {
      dev: stats.dev.toString(),
      ino: stats.ino.toString(),
      birthtimeNs: stats.birthtimeNs.toString()
    }
  } catch (error) {
    const code = getErrorCode(error)
    // Unreadable proves nothing, so it never matches.
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'absent' : null
  }
}

/**
 * Identity of the checkout directory at `path`; undefined when there is no directory there or the
 * filesystem keeps no creation time, since device and inode alone can name a newer directory.
 */
export async function readCheckoutDirectoryIdentity(
  path: string
): Promise<CheckoutDirectoryIdentity | undefined> {
  const current = await statDirectory(path)
  return current && current !== 'absent' && current.birthtimeNs !== '0' ? current : undefined
}

/** Whether `path` still holds the directory a removal accepted. */
export async function matchCheckoutDirectory(
  path: string,
  accepted: CheckoutDirectoryIdentity | undefined
): Promise<CheckoutDirectoryMatch> {
  const current = await statDirectory(path)
  if (current === 'absent') {
    return 'absent'
  }
  if (!accepted) {
    return 'unrecorded'
  }
  if (!current || current.dev !== accepted.dev || current.ino !== accepted.ino) {
    return 'different'
  }
  // Why creation time too: Linux filesystems reuse a freed inode number for the next directory.
  return accepted.birthtimeNs !== '0' && current.birthtimeNs === accepted.birthtimeNs
    ? 'same'
    : 'different'
}
