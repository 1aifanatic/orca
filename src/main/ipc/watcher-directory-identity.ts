import type { BigIntStats } from 'node:fs'

export function watcherDirectoryIdentity(entry: BigIntStats): string | null {
  if (!entry.isDirectory()) {
    return null
  }
  // Some volumes omit inode IDs; birth time survives ordinary directory edits.
  return entry.ino === 0n ? `${entry.dev}:birth:${entry.birthtimeNs}` : `${entry.dev}:${entry.ino}`
}
