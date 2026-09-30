import { lstat, stat } from 'node:fs/promises'
import { mapWithConcurrency } from '../../../shared/map-with-concurrency'

/** One file whose change can move a derived row. `noFollow` stats the link itself, as Git's
 *  `file_exists` does for a checkout's `.git`. */
export type AdminStatDependency = { path: string; noFollow?: boolean }

const MISSING = 'missing'
// Why: mirrors the head-identity reader and sparse probes, so a validation of hundreds of entries
// never queues its whole admin dir onto the libuv threadpool at once.
export const ADMIN_STAT_CONCURRENCY = 8

/**
 * A stamp that moves whenever the file is rewritten. Git writes HEAD, refs and `gitdir` through
 * lock-and-rename, so the inode moves even when the mtime granule does not. Null when the stat
 * failed for a reason other than absence: an unknown always counts as changed.
 */
export async function readAdminStatStamp(dependency: AdminStatDependency): Promise<string | null> {
  try {
    const stats = await (dependency.noFollow ? lstat(dependency.path) : stat(dependency.path))
    return `${stats.mtimeMs}:${stats.ctimeMs}:${stats.size}:${stats.ino}`
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code
    return code === 'ENOENT' || code === 'ENOTDIR' ? MISSING : null
  }
}

export type AdminStatSignature = readonly (string | null)[]

export async function readAdminStatSignature(
  dependencies: readonly AdminStatDependency[]
): Promise<AdminStatSignature> {
  return mapWithConcurrency(dependencies, ADMIN_STAT_CONCURRENCY, readAdminStatStamp)
}

export function isAdminStatSignatureUnchanged(
  previous: AdminStatSignature | undefined,
  current: AdminStatSignature
): boolean {
  return (
    previous !== undefined &&
    previous.length === current.length &&
    previous.every((stamp, index) => stamp !== null && stamp === current[index])
  )
}
