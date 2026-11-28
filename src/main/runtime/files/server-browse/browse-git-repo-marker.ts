import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { mapWithConcurrency } from '../../../../shared/concurrency/map-with-concurrency'

// Bounded so a folder with thousands of children doesn't open thousands of stats at once.
const GIT_MARKER_STAT_CONCURRENCY = 16

/** A hint only: `.git` as a folder (checkout) or file (linked worktree, submodule). Registration still validates. */
export async function hasGitMarker(dirPath: string): Promise<boolean> {
  try {
    const marker = await lstat(join(dirPath, '.git'))
    return marker.isDirectory() || marker.isFile()
  } catch {
    return false
  }
}

export async function markGitRepoEntries<T extends { name: string; isDirectory: boolean }>(
  dirPath: string,
  entries: T[]
): Promise<(T & { isGitRepo?: true })[]> {
  return mapWithConcurrency(entries, GIT_MARKER_STAT_CONCURRENCY, async (entry) =>
    entry.isDirectory && (await hasGitMarker(join(dirPath, entry.name)))
      ? { ...entry, isGitRepo: true as const }
      : entry
  )
}
