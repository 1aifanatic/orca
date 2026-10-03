import { lstat } from 'node:fs/promises'
import { getErrorCode } from './git/worktree-operation-options'

/**
 * The directory a removal accepted, by filesystem identity. A delete Orca finishes later (a retry
 * or a restart's resume) must only take that directory: a folder created at the same path since is
 * the user's, however much it looks like the leftover. Decimal strings keep 64-bit ids exact.
 */
export type CheckoutDirectoryIdentity = {
  // Why no device number: it changes when an external volume is attached again.
  ino: string
  /**
   * Positive: a filesystem without creation times reports `0` (negative on Windows), and nothing is
   * recorded. Linux without statx reports the change time instead, which a partial delete moves, so
   * the leftover there reads as a different folder and is left in place.
   */
  birthtimeNs: string
}

/**
 * `absent`: nothing at the path. `unrecorded`: no identity was recorded, so nothing is provable.
 * `unreadable`: the path could not be read just now, so it is neither the same nor different.
 */
export type CheckoutDirectoryMatch = 'same' | 'different' | 'absent' | 'unrecorded' | 'unreadable'

async function statDirectory(
  path: string
): Promise<CheckoutDirectoryIdentity | 'absent' | 'unreadable' | null> {
  try {
    const stats = await lstat(path, { bigint: true })
    if (!stats.isDirectory()) {
      return null
    }
    return { ino: stats.ino.toString(), birthtimeNs: stats.birthtimeNs.toString() }
  } catch (error) {
    const code = getErrorCode(error)
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'absent' : 'unreadable'
  }
}

// A positive decimal; a parsed record's value may be anything.
function hasCreationTime(identity: CheckoutDirectoryIdentity): boolean {
  return /^[1-9]\d*$/.test(identity.birthtimeNs)
}

/**
 * Identity of the checkout directory at `path`; undefined when there is no directory there or the
 * filesystem keeps no creation time, since the inode alone can name a newer directory.
 */
export async function readCheckoutDirectoryIdentity(
  path: string
): Promise<CheckoutDirectoryIdentity | undefined> {
  const current = await statDirectory(path)
  return typeof current === 'object' && current && hasCreationTime(current) ? current : undefined
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
  if (current === 'unreadable') {
    return 'unreadable'
  }
  if (!current || current.ino !== accepted.ino) {
    return 'different'
  }
  // Why creation time too: Linux filesystems reuse a freed inode number for the next directory.
  return hasCreationTime(accepted) && current.birthtimeNs === accepted.birthtimeNs
    ? 'same'
    : 'different'
}
