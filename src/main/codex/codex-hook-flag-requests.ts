import { watch, type FSWatcher } from 'node:fs'
import {
  ensureCodexHookFlagTable,
  getCodexHookFlagTablePath,
  takeCodexHookFlagRequests
} from './codex-hook-flag-table'
import { clearCodexHookSessionFlags, handleCodexHookFlagRequest } from './codex-hook-session-trust'
import { ensureCodexCmdHookFlagGate } from './codex-cmd-hook-flag-gate'

// Why a short debounce: a launch writes its request once, and a burst of panes shares one drain.
const DRAIN_DEBOUNCE_MS = 100

/**
 * App start, main process only. Serves the requests launches leave in the flag
 * table when it has no entry for their Codex version, including those left
 * while Orca was closed; nothing polls, since a request exists only after a
 * miss. Returns a stop function.
 */
export function startCodexHookFlagRequests(options: { isEnabled: () => boolean }): () => void {
  const table = getCodexHookFlagTablePath()
  // Why: every native cmd pane calls the gate, even one opened while hooks are off.
  ensureCodexCmdHookFlagGate()
  try {
    ensureCodexHookFlagTable(table)
    // Why clear here when off: the table is this profile's alone, unlike user-wide hook files.
    if (!options.isEnabled()) {
      clearCodexHookSessionFlags()
    }
  } catch (error) {
    console.warn('[codex-hook-session] could not create the Codex hook flag table:', error)
    return () => {}
  }
  let timer: ReturnType<typeof setTimeout> | null = null
  const drain = (): void => {
    timer = null
    const requests = takeCodexHookFlagRequests(table)
    // Why drained while off: launches still ask, and an answer would re-enable the hook.
    if (!options.isEnabled()) {
      return
    }
    for (const request of requests) {
      void handleCodexHookFlagRequest(request)
    }
  }
  let watcher: FSWatcher | null = null
  try {
    // Why any event: macOS can report a burst under the directory's own name, not the request's.
    watcher = watch(table, () => {
      timer ??= setTimeout(drain, DRAIN_DEBOUNCE_MS)
    })
    watcher.on('error', (error) => {
      console.warn('[codex-hook-session] Codex hook flag request watch failed:', error)
    })
    watcher.unref()
  } catch (error) {
    // Why not fatal: requests left behind are served at the next start.
    console.warn('[codex-hook-session] could not watch Codex hook flag requests:', error)
  }
  drain()
  return () => {
    watcher?.close()
    if (timer) {
      clearTimeout(timer)
    }
  }
}
