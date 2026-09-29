// Why a bounded walk: a recursive `fs.promises.rm` queues every entry of a ~100k-entry worktree on
// libuv's 4-thread pool, so every other async fs call in the process (the agent-session store
// behind chat sends) waited minutes behind it. Every fs call a tree delete makes holds one of two
// process-wide slots, which keeps the rest of the pool free.
// Why `rm` per entry and not native recursive `rmSync`: on Windows the native walk follows junctions
// out of the tree and fails on read-only files; Node's JS `rm` unlinks the link and clears the flag.

import type { Dirent, RmOptions } from 'node:fs'
import { join } from 'node:path'
import { asarTransparentFs } from './asar-transparent-fs'
import { PrioritySemaphore } from '../shared/priority-semaphore'

/** `background`: fire-and-forget bulk deletes (worktree trash, history tombstones). `interactive`: a caller awaits it. */
export type TreeRemovalLane = 'interactive' | 'background'

const TREE_REMOVAL_FS_CALL_SLOTS = 2
// Why two lanes per directory: enough to keep both slots busy without one promise per entry.
const CHILD_REMOVAL_FAN_OUT = 2
const LANE_PRIORITY: Record<TreeRemovalLane, number> = { interactive: 0, background: 1 }

const fsCallSlots = new PrioritySemaphore(TREE_REMOVAL_FS_CALL_SLOTS)

async function withFsCallSlot<T>(lane: TreeRemovalLane, call: () => Promise<T>): Promise<T> {
  const release = await fsCallSlots.acquire(LANE_PRIORITY[lane])
  try {
    return await call()
  } finally {
    release()
  }
}

function isVanishedEntryError(error: unknown): boolean {
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : null
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/** Runs `remove` over `items`, `width` at a time; stops taking items after a failure and rethrows it once all lanes settle. */
async function removeEach<T>(
  items: readonly T[],
  width: number,
  remove: (item: T) => Promise<void>
): Promise<void> {
  const failures: unknown[] = []
  let next = 0
  const lane = async (): Promise<void> => {
    while (failures.length === 0 && next < items.length) {
      const item = items[next++]
      try {
        await remove(item)
      } catch (error) {
        failures.push(error)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, lane))
  if (failures.length > 0) {
    throw failures[0]
  }
}

/** Recursive remove whose fs calls never take more than two pool threads; rejects with the stuck entry's fs error. */
export async function removeTreeWithBoundedFsCalls(
  targetPath: string,
  options: RmOptions,
  lane: TreeRemovalLane
): Promise<void> {
  const fs = asarTransparentFs()

  // Why unlink/rmdir first: one pool op per entry. `rm` (lstat, Windows read-only fix, lock
  // retries) runs only when that fails.
  const removeEntry = (path: string, isDirectory: boolean): Promise<void> =>
    withFsCallSlot(lane, () =>
      (isDirectory ? fs.rmdir(path) : fs.unlink(path)).catch(() => fs.rm(path, options))
    )

  const removeTree = async (path: string): Promise<void> => {
    let children: Dirent[] = []
    let isDirectory = false
    try {
      // Why lstat and never the Dirent alone: a symlink or junction must be unlinked, not followed.
      isDirectory = (await withFsCallSlot(lane, () => fs.lstat(path))).isDirectory()
      if (isDirectory) {
        children = await withFsCallSlot(lane, () => fs.readdir(path, { withFileTypes: true }))
      }
    } catch (error) {
      if (!isVanishedEntryError(error)) {
        throw error
      }
    }
    await removeEach(children, CHILD_REMOVAL_FAN_OUT, (child) => {
      const childPath = join(path, child.name)
      return child.isDirectory() ? removeTree(childPath) : removeEntry(childPath, false)
    })
    await removeEntry(path, isDirectory)
  }

  await removeTree(targetPath)
}
