// The old per-chat files on disk, for the background copy: where they are, what is left once they
// are copied, and whether the volume has room to copy one.

import { existsSync } from 'node:fs'
import { readdir, rmdir, statfs } from 'node:fs/promises'
import { join } from 'node:path'
import type { PerChatFileState } from '../agent-session-journal/journal-copy-failures'
import {
  legacyJournalDatabaseFile,
  perChatJournalRoot
} from '../agent-session-journal/journal-paths'

const MIN_FREE_BYTES = 512 * 1024 * 1024
/** Free space a chat needs before its copy starts, as a multiple of its file and WAL. */
const FREE_SPACE_FACTOR = 4

/** Each `<workspace>/<session>` directory that still holds a `journal.db`, one at a time. A
 *  directory without one is counted and kept: a pre-SQLite transcript, or an older build's. */
export async function* walkPerChatFiles(
  stateDirectory: string,
  onLeftover: () => void
): AsyncGenerator<string> {
  const root = perChatJournalRoot(stateDirectory)
  for (const workspace of await readdirOrEmpty(root)) {
    for (const session of await readdirOrEmpty(join(root, workspace))) {
      const directory = join(root, workspace, session)
      if (existsSync(legacyJournalDatabaseFile(directory))) {
        yield directory
      } else {
        onLeftover()
      }
    }
  }
}

/** Best effort, and only what is empty: anything left in a directory is the user's. */
export async function removeEmptyPerChatDirectories(stateDirectory: string): Promise<void> {
  const root = perChatJournalRoot(stateDirectory)
  for (const workspace of await readdirOrEmpty(root)) {
    await rmdir(join(root, workspace)).catch(() => undefined)
  }
  await rmdir(root).catch(() => undefined)
}

/** max(512 MiB, 4 x the chat's file and WAL) free on the state volume; unknown space copies. */
export async function hasRoomToCopy(
  stateDirectory: string,
  file: PerChatFileState,
  freeBytes: (directory: string) => Promise<number | null> = freeBytesOnVolume
): Promise<boolean> {
  const free = await freeBytes(stateDirectory)
  const needed = Math.max(MIN_FREE_BYTES, FREE_SPACE_FACTOR * (file.dbSize + (file.walSize ?? 0)))
  return free === null || free >= needed
}

async function readdirOrEmpty(directory: string): Promise<string[]> {
  try {
    return await readdir(directory)
  } catch {
    return []
  }
}

async function freeBytesOnVolume(directory: string): Promise<number | null> {
  try {
    const stats = await statfs(directory)
    const bytes = Number(stats.bsize) * Number(stats.bavail)
    return Number.isFinite(bytes) ? bytes : null
  } catch {
    return null
  }
}
