import { createContext } from 'react'
import type { ParsedTerminalFileLink } from '@/lib/terminal-links'
import { isWorktreeConnectionResolved } from '@/lib/connection-context'
import type { FileLinkExists } from '@/components/sidebar/comment-markdown-native-chat-file-links'
import { createTerminalPathExistenceBatch } from '@/components/terminal-pane/terminal-path-existence-batch'
import {
  readTerminalPathExistsCache,
  writeTerminalPathExistsCache
} from '@/components/terminal-pane/terminal-path-exists-cache'
import {
  resolveFileLinkTarget,
  type FileLinkHost,
  type FileLinkPathExistence,
  type FileLinkTarget
} from '@/components/terminal-pane/terminal-file-link-target'

// Why: a host that could not answer is retried a few times, then waits for the next recheck.
export const UNVERIFIABLE_RETRY_DELAYS_MS = [2_000, 10_000, 30_000] as const

/** The lookups one rendered message makes; a new snapshot means one of its answers changed. */
export type NativeChatFileLinkSnapshot = {
  /** Asks the host about unknown or outdated paths. */
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
  /** Files may have changed (a turn ended, the host came back): ask again about every watched path. */
  recheck: () => void
}

/** The generation is the recheck an answer was asked in; older answers still show but are re-asked. */
type Answer = { exists: boolean; generation: number }

type WatcherState = {
  /** Paths this message has an answer for, or asked about. */
  held: Map<string, FileLinkTarget>
  subscribed: boolean
  refresh: () => void
}

export const NativeChatFileLinkExistenceContext = createContext<NativeChatFileLinkExistence | null>(
  null
)

export function createNativeChatFileLinkExistence(
  host: FileLinkHost,
  pathExists: FileLinkPathExistence = createTerminalPathExistenceBatch()
): NativeChatFileLinkExistence {
  let generation = 0
  const answers = new Map<string, Answer>()
  /** Generation each outstanding request was sent in. */
  const inFlight = new Map<string, number>()
  /** Paths the host could not answer in this generation, with their pending retry. */
  const failures = new Map<string, { attempt: number; timer?: ReturnType<typeof setTimeout> }>()
  /** Subscribed messages per path, so a changed answer refreshes only them. */
  const holders = new Map<string, { target: FileLinkTarget; watchers: Set<WatcherState> }>()

  const clearFailure = (key: string): void => {
    clearTimeout(failures.get(key)?.timer)
    failures.delete(key)
  }

  const settle = (key: string, sentIn: number, exists: boolean): void => {
    if (inFlight.get(key) === sentIn) {
      inFlight.delete(key)
    }
    const previous = answers.get(key)
    // Why: a reply to an older question must not overwrite what a newer one found.
    if (previous && previous.generation > sentIn) {
      return
    }
    if (sentIn === generation) {
      clearFailure(key)
    }
    writeTerminalPathExistsCache(answers, key, { exists, generation: sentIn })
    if ((previous?.exists ?? false) !== exists) {
      for (const watcher of holders.get(key)?.watchers ?? []) {
        watcher.refresh()
      }
    }
  }

  const fail = (key: string, sentIn: number): void => {
    if (inFlight.get(key) === sentIn) {
      inFlight.delete(key)
    }
    // Why: a recheck since then has asked again; an unreachable host is not evidence the file is gone.
    if (sentIn !== generation) {
      return
    }
    const attempt = (failures.get(key)?.attempt ?? -1) + 1
    const delay = UNVERIFIABLE_RETRY_DELAYS_MS[attempt]
    clearTimeout(failures.get(key)?.timer)
    failures.set(key, {
      attempt,
      timer: delay === undefined ? undefined : setTimeout(() => retry(key), delay)
    })
  }

  const send = (target: FileLinkTarget): void => {
    const key = target.cacheKey
    if (inFlight.get(key) === generation) {
      return
    }
    const sentIn = generation
    inFlight.set(key, sentIn)
    const ask = async (): Promise<boolean> =>
      pathExists(target.fileContext, target.absolutePath, target.isRemoteRuntimePath)
    void ask().then(
      (exists) => settle(key, sentIn, exists),
      () => fail(key, sentIn)
    )
  }

  const retry = (key: string): void => {
    const failure = failures.get(key)
    const held = holders.get(key)
    if (!failure) {
      return
    }
    failure.timer = undefined
    if (held) {
      send(held.target)
    } else {
      failures.delete(key)
    }
  }

  const index = (watcher: WatcherState, target: FileLinkTarget): void => {
    const entry = holders.get(target.cacheKey) ?? { target, watchers: new Set<WatcherState>() }
    entry.watchers.add(watcher)
    holders.set(target.cacheKey, entry)
  }

  const unindex = (watcher: WatcherState): void => {
    for (const key of watcher.held.keys()) {
      const entry = holders.get(key)
      entry?.watchers.delete(watcher)
      if (entry?.watchers.size === 0) {
        holders.delete(key)
        // Why: nothing shows this path any more, so its retries end here.
        clearFailure(key)
      }
    }
  }

  // Why: until an SSH workspace's connection is known, an unrouted check would stat this machine (#6648).
  const isHostUnresolved = (target: FileLinkTarget): boolean =>
    !target.fileContext.connectionId &&
    !target.isRemoteRuntimePath &&
    !isWorktreeConnectionResolved(host.worktreeId)

  const lookup = (
    link: ParsedTerminalFileLink,
    watcher: WatcherState,
    mayAsk: boolean
  ): boolean => {
    const target = resolveFileLinkTarget(link, host)
    if (target?.isKnownWorktreeRoot) {
      return true
    }
    if (!target || isHostUnresolved(target)) {
      return false
    }
    const key = target.cacheKey
    const answer = readTerminalPathExistsCache(answers, key)
    if (!answer && !mayAsk) {
      return false
    }
    watcher.held.set(key, target)
    if (watcher.subscribed) {
      index(watcher, target)
    }
    const outdated = !answer || answer.generation < generation
    if (mayAsk && outdated && !failures.has(key)) {
      send(target)
    }
    return answer?.exists ?? false
  }

  return {
    watch: () => {
      const listeners = new Set<() => void>()
      const state: WatcherState = { held: new Map(), subscribed: false, refresh: () => {} }
      const createSnapshot = (): NativeChatFileLinkSnapshot => ({
        check: (link) => lookup(link, state, true),
        peek: (link) => lookup(link, state, false)
      })
      let snapshot = createSnapshot()
      state.refresh = () => {
        snapshot = createSnapshot()
        for (const listener of listeners) {
          listener()
        }
      }
      return {
        subscribe: (listener) => {
          listeners.add(listener)
          if (!state.subscribed) {
            state.subscribed = true
            for (const target of state.held.values()) {
              index(state, target)
            }
          }
          return () => {
            listeners.delete(listener)
            if (listeners.size === 0 && state.subscribed) {
              state.subscribed = false
              unindex(state)
            }
          }
        },
        getSnapshot: () => snapshot
      }
    },
    recheck: () => {
      generation += 1
      for (const { timer } of failures.values()) {
        clearTimeout(timer)
      }
      failures.clear()
      // Why: messages keep showing their answers; only those whose answer changes re-render.
      for (const { target } of holders.values()) {
        send(target)
      }
    }
  }
}
