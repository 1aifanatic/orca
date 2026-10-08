import { createContext } from 'react'
import type { ParsedTerminalFileLink } from '@/lib/terminal-links'
import type { FileLinkExists } from '@/components/sidebar/comment-markdown-native-chat-file-links'
import { createTerminalPathExistenceBatch } from '@/components/terminal-pane/terminal-path-existence-batch'
import { readTerminalPathExistsCache } from '@/components/terminal-pane/terminal-path-exists-cache'
import {
  fileLinkTargetExists,
  resolveFileLinkTarget,
  type FileLinkHost,
  type FileLinkPathExistence,
  type FileLinkTarget
} from '@/components/terminal-pane/terminal-file-link-target'

// Why: a streaming reply re-renders per token; a host that could not answer is not re-asked every frame.
const RETRY_UNVERIFIABLE_AFTER_MS = 15_000

/** The lookups one rendered message makes; a new snapshot means one of its paths was confirmed. */
export type NativeChatFileLinkSnapshot = {
  /** Asks the host about unknown paths. */
  check: FileLinkExists
  /** Answers from what is already known; for text still streaming in. */
  peek: FileLinkExists
}

export type NativeChatFileLinkWatcher = {
  subscribe: (listener: () => void) => () => void
  getSnapshot: () => NativeChatFileLinkSnapshot
}

export type NativeChatFileLinkExistence = {
  watch: () => NativeChatFileLinkWatcher
  /** A turn may have created files it mentioned earlier; ask about them again. */
  forgetMissing: () => void
}

type WatcherState = {
  keys: Set<string>
  refresh: () => void
}

export const NativeChatFileLinkExistenceContext = createContext<NativeChatFileLinkExistence | null>(
  null
)

export function createNativeChatFileLinkExistence(
  host: FileLinkHost,
  pathExists: FileLinkPathExistence = createTerminalPathExistenceBatch()
): NativeChatFileLinkExistence {
  const cache = new Map<string, boolean>()
  const inFlight = new Set<string>()
  const unverifiableAt = new Map<string, number>()
  const watchers = new Set<WatcherState>()

  const refreshWatchersOf = (keys: ReadonlySet<string>): void => {
    for (const watcher of watchers) {
      if ([...keys].some((key) => watcher.keys.has(key))) {
        watcher.refresh()
      }
    }
  }

  const ask = (target: FileLinkTarget): void => {
    const key = target.cacheKey
    const failedAt = unverifiableAt.get(key)
    if (
      inFlight.has(key) ||
      (failedAt !== undefined && Date.now() - failedAt < RETRY_UNVERIFIABLE_AFTER_MS)
    ) {
      return
    }
    inFlight.add(key)
    void fileLinkTargetExists(target, cache, pathExists).then(
      (exists) => {
        inFlight.delete(key)
        unverifiableAt.delete(key)
        if (exists) {
          refreshWatchersOf(new Set([key]))
        }
      },
      () => {
        // Why: an unreachable host is not evidence the file is gone; leave it unlinked, uncached.
        inFlight.delete(key)
        unverifiableAt.set(key, Date.now())
      }
    )
  }

  const lookup = (link: ParsedTerminalFileLink, keys: Set<string>, shouldAsk: boolean): boolean => {
    const target = resolveFileLinkTarget(link, host)
    if (!target) {
      return false
    }
    if (target.isKnownWorktreeRoot) {
      return true
    }
    const known = readTerminalPathExistsCache(cache, target.cacheKey)
    if (known !== undefined) {
      if (!known) {
        keys.add(target.cacheKey)
      }
      return known
    }
    if (shouldAsk) {
      keys.add(target.cacheKey)
      ask(target)
    }
    return false
  }

  return {
    watch: () => {
      const keys = new Set<string>()
      const listeners = new Set<() => void>()
      const createSnapshot = (): NativeChatFileLinkSnapshot => ({
        check: (link) => lookup(link, keys, true),
        peek: (link) => lookup(link, keys, false)
      })
      let snapshot = createSnapshot()
      const state: WatcherState = {
        keys,
        refresh: () => {
          snapshot = createSnapshot()
          for (const listener of listeners) {
            listener()
          }
        }
      }
      return {
        subscribe: (listener) => {
          listeners.add(listener)
          watchers.add(state)
          return () => {
            listeners.delete(listener)
            if (listeners.size === 0) {
              watchers.delete(state)
            }
          }
        },
        getSnapshot: () => snapshot
      }
    },
    forgetMissing: () => {
      const missing = new Set<string>()
      for (const [key, exists] of cache) {
        if (!exists) {
          missing.add(key)
        }
      }
      for (const key of missing) {
        cache.delete(key)
      }
      if (missing.size > 0) {
        refreshWatchersOf(missing)
      }
    }
  }
}
