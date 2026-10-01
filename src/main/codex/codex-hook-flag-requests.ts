import { watch, type FSWatcher } from 'node:fs'
import {
  createCodexHookFlagTable,
  getCodexHookFlagTablePath,
  takeCodexHookFlagRequests
} from './codex-hook-flag-table'
import { clearCodexHookSessionFlags, handleCodexHookFlagRequest } from './codex-hook-session-trust'
import { ensureCodexCmdHookFlagGate } from './codex-cmd-hook-flag-gate'

// Why a short debounce: a launch writes its request once, and a burst of panes shares one drain.
const DRAIN_DEBOUNCE_MS = 100

type Listener = {
  isEnabled: () => boolean
  watcher: FSWatcher | null
  timer: NodeJS.Timeout | null
}

// Why module state: the table is recreated when hooks turn back on, and the watch must follow it.
let listener: Listener | null = null

/**
 * App start, main process only. Creates or removes this profile's flag table
 * to match the setting, and serves the requests launches leave in it when it
 * has no entry for their Codex version, including those left while Orca was
 * closed. Nothing polls: a request exists only after a miss.
 */
export function startCodexHookFlagRequests(options: { isEnabled: () => boolean }): () => void {
  // Why: every native cmd pane calls the gate, even one opened while hooks are off.
  ensureCodexCmdHookFlagGate()
  listener = { isEnabled: options.isEnabled, watcher: null, timer: null }
  if (options.isEnabled()) {
    openCodexHookFlagTable()
  } else {
    closeCodexHookFlagTable()
  }
  return stopListening
}

/** Hooks on: launches start probing and requesting. Safe in any process; only app start's process watches. */
export function openCodexHookFlagTable(): void {
  try {
    createCodexHookFlagTable()
  } catch (error) {
    console.warn('[codex-hook-session] could not create the Codex hook flag table:', error)
    return
  }
  if (listener) {
    watchTable(listener)
    drain(listener)
  }
}

/** Hooks off: removes the table, so open panes run plain codex at their next launch. */
export function closeCodexHookFlagTable(): void {
  if (listener) {
    unwatch(listener)
  }
  clearCodexHookSessionFlags()
}

function watchTable(current: Listener): void {
  unwatch(current)
  try {
    // Why any event: macOS can report a burst under the directory's own name, not the request's.
    current.watcher = watch(getCodexHookFlagTablePath(), () => {
      current.timer ??= setTimeout(() => drain(current), DRAIN_DEBOUNCE_MS)
    })
    current.watcher.on('error', (error) => {
      console.warn('[codex-hook-session] Codex hook flag request watch failed:', error)
    })
    current.watcher.unref()
  } catch (error) {
    // Why not fatal: requests left behind are served at the next start.
    console.warn('[codex-hook-session] could not watch Codex hook flag requests:', error)
  }
}

function drain(current: Listener): void {
  current.timer = null
  const requests = takeCodexHookFlagRequests()
  if (!current.isEnabled()) {
    return
  }
  for (const request of requests) {
    void handleCodexHookFlagRequest(request)
  }
}

function unwatch(current: Listener): void {
  current.watcher?.close()
  current.watcher = null
  if (current.timer) {
    clearTimeout(current.timer)
    current.timer = null
  }
}

function stopListening(): void {
  if (listener) {
    unwatch(listener)
    listener = null
  }
}
