import { statSync, type FSWatcher } from 'node:fs'
import { readlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, parse, sep } from 'node:path'
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'

export type WatchFolder = (path: string, onChange: () => void) => FSWatcher

export type FolderWatch = {
  /** Watches exactly these folders, reopening one replaced under the same name. */
  follow(folders: readonly string[]): void
  close(): void
}

/**
 * One watch per folder, calling `onChange` once a burst of events has been
 * quiet for `settleMs`. Any event counts: macOS can report a burst under the
 * folder's own name, or none. A failed watch is dropped; the next follow reopens it.
 */
export function createFolderWatch(
  watch: WatchFolder,
  onChange: () => void,
  settleMs: number
): FolderWatch {
  const watches = new Map<string, { watcher: FSWatcher; identity: string }>()
  let settle: ReturnType<typeof setTimeout> | null = null
  const changed = (): void => {
    if (settle) {
      clearTimeout(settle)
    }
    settle = setTimeout(() => {
      settle = null
      onChange()
    }, settleMs)
  }
  const drop = (key: string): void => {
    watches.get(key)?.watcher.close()
    watches.delete(key)
  }
  const open = (key: string, folder: string, identity: string): void => {
    try {
      const watcher = watch(folder, changed)
      watcher.on('error', (error) => {
        console.warn('[codex-hook-session] watch failed:', folder, error)
        if (watches.get(key)?.watcher === watcher) {
          drop(key)
        }
      })
      watcher.unref()
      watches.set(key, { watcher, identity })
    } catch (error) {
      console.warn('[codex-hook-session] could not watch:', folder, error)
    }
  }
  return {
    follow(folders) {
      const wanted = new Map(
        folders.map((folder) => [normalizeRuntimePathForComparison(folder), folder])
      )
      for (const key of watches.keys()) {
        if (!wanted.has(key)) {
          drop(key)
        }
      }
      for (const [key, folder] of wanted) {
        const identity = readFolderIdentity(folder)
        if (watches.get(key)?.identity === identity) {
          continue
        }
        drop(key)
        if (identity !== null) {
          open(key, folder, identity)
        }
      }
    },
    close() {
      for (const key of watches.keys()) {
        drop(key)
      }
      if (settle) {
        clearTimeout(settle)
        settle = null
      }
    }
  }
}

// Why the inode too: on Linux a watch follows the folder an update replaced, not the new one.
function readFolderIdentity(folder: string): string | null {
  try {
    const info = statSync(folder)
    return info.isDirectory() ? `${info.dev}:${info.ino}` : null
  } catch {
    return null
  }
}

// Why a hop limit: a link cycle must end the walk, as it ends the OS's own resolution.
const MAX_LINK_HOPS = 32

/**
 * The folder of every symlink on the way from `path` to its real file, and of
 * that file, at most `max` of them, the file's always: an update relinks one
 * (a PATH entry, a `current` release link) or rewrites the file. POSIX only.
 */
export async function readLinkChainFolders(path: string, max: number): Promise<string[]> {
  const folders: string[] = []
  let resolved = parse(path).root
  let remaining = path.split(sep).filter(Boolean)
  for (let hops = 0; remaining.length > 0 && hops < MAX_LINK_HOPS;) {
    const next = join(resolved, remaining[0])
    const target = await readlink(next).catch(() => null)
    remaining = remaining.slice(1)
    if (target === null) {
      resolved = next
      continue
    }
    hops += 1
    // Why not a link at the filesystem root (macOS /var, /tmp): no update flips those.
    if (resolved !== parse(resolved).root) {
      folders.push(resolved)
    }
    const absolute = isAbsolute(target) ? target : join(resolved, target)
    remaining = [...absolute.split(sep).filter(Boolean), ...remaining]
    resolved = parse(absolute).root
  }
  const unique = [...new Set([...folders, dirname(resolved)])]
  return unique.length > max ? [...unique.slice(0, max - 1), dirname(resolved)] : unique
}
