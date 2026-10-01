import { watch as watchFs, type FSWatcher } from 'node:fs'
import {
  createCodexHookFlagTable,
  getCodexHookFlagTablePath,
  takeCodexHookFlagRequests
} from './codex-hook-flag-table'
import {
  clearCodexHookSessionFlags,
  handleCodexHookFlagRequest,
  pruneCodexHookSessionFlags,
  refreshCodexHookSessionFlagsAfter
} from './codex-hook-session-trust'
import { ensureCodexCmdHookFlagGate } from './codex-cmd-hook-flag-gate'

// Why a short debounce: a launch writes its request once, and a burst of panes shares one drain.
const DRAIN_DEBOUNCE_MS = 100
// Why a second look: a watch can miss a write landing just after it opens (macOS, app start).
const SETTLE_DRAIN_MS = 1_000

type WatchTable = (path: string, onChange: () => void) => FSWatcher

type Listener = {
  isEnabled: () => boolean
  watch: WatchTable
  watcher: FSWatcher | null
  debounce: ReturnType<typeof setTimeout> | null
  timers: Set<ReturnType<typeof setTimeout>>
}

// Why module state: the table is recreated when hooks turn back on, and the watch must follow it.
let listener: Listener | null = null

/**
 * App start, main process only. Makes the flag table match the setting,
 * starts the default derivation once `pathReady` settles, and serves the
 * requests launches leave when the table has no entry for their Codex version,
 * including those left while Orca was closed. Never throws.
 */
export function startCodexHookFlagRequests(options: {
  isEnabled: () => boolean
  /** Shell PATH hydration, which the codex command resolution needs. */
  pathReady?: Promise<unknown>
  watch?: WatchTable
}): () => void {
  try {
    // Why: every native cmd pane calls the gate, even one opened while hooks are off.
    ensureCodexCmdHookFlagGate()
    listener = {
      isEnabled: options.isEnabled,
      watch: options.watch ?? ((path, onChange) => watchFs(path, onChange)),
      watcher: null,
      debounce: null,
      timers: new Set()
    }
    reconcileCodexHookFlagTable()
    if (options.isEnabled()) {
      refreshCodexHookSessionFlagsAfter(options.pathReady ?? Promise.resolve())
    }
  } catch (error) {
    console.warn('[codex-hook-session] could not start the Codex hook flag table:', error)
  }
  return stopListening
}

/**
 * Makes the table exist exactly while Codex hooks are on, read from the
 * setting when this runs (the app's listener), else from the caller's intent
 * (the CLI's process, which already saved the setting). Every toggle path
 * lands here, so the last one to run cannot leave the table out of step.
 * Never throws: bookkeeping must not stop a start or an opt-out.
 */
export function reconcileCodexHookFlagTable(intent = false): void {
  try {
    if (listener ? listener.isEnabled() : intent) {
      openTable()
    } else {
      closeTable()
    }
  } catch (error) {
    console.warn('[codex-hook-session] could not reconcile the Codex hook flag table:', error)
  }
}

/** A pane spawned or a main-side launch missed: serve requests even if the watch missed them. */
export function nudgeCodexHookFlagRequests(): void {
  if (listener?.isEnabled()) {
    queueDrain(listener)
  }
}

function openTable(): void {
  createCodexHookFlagTable()
  void pruneCodexHookSessionFlags().catch((error: unknown) => {
    console.warn('[codex-hook-session] could not prune the Codex hook flag table:', error)
  })
  if (!listener) {
    return
  }
  if (!listener.watcher) {
    watchTable(listener)
  }
  scheduleDrain(listener, 0)
  scheduleDrain(listener, SETTLE_DRAIN_MS)
}

function closeTable(): void {
  if (listener) {
    unwatch(listener)
  }
  clearCodexHookSessionFlags()
}

function watchTable(current: Listener): void {
  try {
    // Why any event: macOS can report a burst under the directory's own name, not the request's.
    const watcher = current.watch(getCodexHookFlagTablePath(), () => queueDrain(current))
    watcher.on('error', (error) => {
      // Why not fatal: pane spawns and the next open still drain.
      console.warn('[codex-hook-session] Codex hook flag request watch failed:', error)
      if (current.watcher === watcher) {
        watcher.close()
        current.watcher = null
      }
    })
    watcher.unref()
    current.watcher = watcher
  } catch (error) {
    console.warn('[codex-hook-session] could not watch Codex hook flag requests:', error)
  }
}

function queueDrain(current: Listener): void {
  if (current.debounce) {
    return
  }
  current.debounce = setTimeout(() => {
    current.debounce = null
    drain(current)
  }, DRAIN_DEBOUNCE_MS)
  current.debounce.unref?.()
}

function scheduleDrain(current: Listener, delayMs: number): void {
  const timer = setTimeout(() => {
    current.timers.delete(timer)
    drain(current)
  }, delayMs)
  timer.unref?.()
  current.timers.add(timer)
}

function drain(current: Listener): void {
  try {
    const requests = takeCodexHookFlagRequests()
    if (!current.isEnabled()) {
      return
    }
    for (const request of requests) {
      void handleCodexHookFlagRequest(request)
    }
  } catch (error) {
    console.warn('[codex-hook-session] could not serve Codex hook flag requests:', error)
  }
}

function unwatch(current: Listener): void {
  current.watcher?.close()
  current.watcher = null
  if (current.debounce) {
    clearTimeout(current.debounce)
    current.debounce = null
  }
  for (const timer of current.timers) {
    clearTimeout(timer)
  }
  current.timers.clear()
}

function stopListening(): void {
  if (listener) {
    unwatch(listener)
    listener = null
  }
}
