import { watch as watchFs, type FSWatcher } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { basename, isAbsolute } from 'node:path'
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'
import { resolveCodexCommand } from '../codex-cli/command'
import { writeManagedScript } from '../agent-hooks/installer-utils'
import { getManagedScriptPath } from './codex-hook-definition'
import { getManagedScript } from './codex-hook-script'
import { ensureCodexCmdHookFlagGate } from './codex-cmd-hook-flag-gate'
import {
  codexHookFlagTableExists,
  createCodexHookFlagTable,
  getCodexHookFlagTablePath,
  pruneCodexHookFlagEntries,
  readCodexHookFlagEntry,
  removeCodexHookFlagTable,
  resolveCodexProbePath,
  takeCodexHookFlagRequests
} from './codex-hook-flag-table'
import {
  deriveCodexHookFlagEntry,
  readCodexHookFlagCheck,
  readCodexVersion
} from './codex-hook-session-trust'

/**
 * Keeps Orca's Codex hook flag table true to the setting and to the codex
 * binaries in use. One never-throwing function, called at app start, on the
 * setting changing, on each native pane spawn, on Orca-side launch prep and
 * resume, and when a launch leaves a request in the table. Each call reads the
 * setting then; a derivation runs only for a binary whose fingerprint changed
 * since its last answer, so a call that finds nothing new spawns nothing.
 */

// Why a short debounce: a burst of launches shares one sync.
const WATCH_DEBOUNCE_MS = 100
// Why a cap: one entry per Codex version ever seen would otherwise accumulate.
const MAX_TABLE_ENTRIES = 8

type WatchTable = (path: string, onChange: () => void) => FSWatcher
type Known = { fingerprint: string; version: string | null; failure: string | null }

let config: { isEnabled: () => boolean; watch: WatchTable } | null = null
// Why: the CLI's process has no store; its toggle passes the setting it just saved.
let intent = false
// Why keyed by path: a fingerprint change (update, reinstall) re-derives that binary only.
const known = new Map<string, Known>()
const pendingPaths = new Set<string>()
let running: Promise<void> | null = null
let rerun = false
let watcher: FSWatcher | null = null
let debounce: ReturnType<typeof setTimeout> | null = null

/** App start, main process only: the settings reader, and the first sync once PATH is hydrated. */
export function startCodexHookFlagSync(options: {
  isEnabled: () => boolean
  /** Shell PATH hydration, which resolving the codex command needs. */
  pathReady?: Promise<unknown>
  watch?: WatchTable
}): () => void {
  config = {
    isEnabled: options.isEnabled,
    watch: options.watch ?? ((path, onChange) => watchFs(path, onChange))
  }
  void syncCodexHookFlags({ after: options.pathReady })
  return () => {
    closeWatcher()
    config = null
  }
}

/**
 * Makes the table exist exactly while Codex hooks are on and derives what is
 * missing. `enabled` is only the CLI's saved setting; the app reads its store.
 * `codexPath` names a binary an Orca-side launch is about to run. Never throws.
 */
export function syncCodexHookFlags(
  options: { enabled?: boolean; codexPath?: string; after?: Promise<unknown> } = {}
): Promise<void> {
  try {
    if (options.enabled !== undefined) {
      intent = options.enabled
    } else if (!config) {
      return Promise.resolve()
    }
    if (!isEnabledNow()) {
      closeWatcher()
      known.clear()
      pendingPaths.clear()
      removeCodexHookFlagTable()
      return Promise.resolve()
    }
    createCodexHookFlagTable()
    // Why nothing is derived without it: a flag whose script is missing runs nothing, or fails every event on Windows.
    if (!ensureCodexHookScripts() || !config) {
      // Why no derivation in the CLI's process: the app derives at its next start.
      return Promise.resolve()
    }
    watchTable()
    if (options.codexPath) {
      pendingPaths.add(options.codexPath)
    }
    if (running) {
      rerun = true
      return running
    }
    const after = options.after ?? Promise.resolve()
    running = after
      .catch(() => {})
      .then(runUntilSettled)
      .catch((error: unknown) => {
        console.warn('[codex-hook-session] Codex hook flag sync failed:', error)
      })
      .finally(() => {
        running = null
      })
    return running
  } catch (error) {
    console.warn('[codex-hook-session] Codex hook flag sync failed:', error)
    return Promise.resolve()
  }
}

/** A native pane spawned: syncs on the next tick, off the spawn's path, in the app's process only. */
export function scheduleCodexHookFlagSync(): void {
  if (config) {
    setImmediate(() => void syncCodexHookFlags())
  }
}

/** A sync, waited for at most `timeoutMs`: a resume launches without its flag rather than wait longer. */
export async function syncCodexHookFlagsWithin(timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    syncCodexHookFlags(),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs)
    })
  ])
  clearTimeout(timer)
}

/** What this process last learned about the codex it resolves; null before it has. */
export function getKnownCodexHookFlag(): { version: string | null; failure: string | null } | null {
  const answer = known.get(normalizeRuntimePathForComparison(resolveCodexCommand()))
  return answer ? { version: answer.version, failure: answer.failure } : null
}

/** The CLI's process: learns its codex's version once, so status names that version's entry. */
export async function learnCodexHookFlagVersion(): Promise<void> {
  if (config) {
    return
  }
  const codexPath = resolveCodexCommand()
  const version = await readCodexVersion(codexPath).catch(() => null)
  known.set(normalizeRuntimePathForComparison(codexPath), {
    fingerprint: await fingerprintCodex(codexPath),
    version,
    failure: version ? null : `${codexPath} did not report its version`
  })
}

function isEnabledNow(): boolean {
  return config ? config.isEnabled() : intent
}

function ensureCodexHookScripts(): boolean {
  try {
    writeManagedScript(getManagedScriptPath(), getManagedScript())
  } catch (error) {
    console.warn('[codex-hook-session] could not write the Codex hook script:', error)
    return false
  }
  ensureCodexCmdHookFlagGate()
  return true
}

async function runUntilSettled(): Promise<void> {
  do {
    rerun = false
    await syncOnce()
  } while (rerun && isEnabledNow())
}

async function syncOnce(): Promise<void> {
  const mainPath = resolveCodexCommand()
  const targets = new Set<string>([mainPath])
  for (const path of pendingPaths) {
    targets.add(resolveCodexProbePath(path))
  }
  pendingPaths.clear()
  for (const request of takeCodexHookFlagRequests()) {
    // Why main's codex for a request without a usable path: cmd.exe cannot name its binary.
    targets.add(readRequestedCodexPath(request.codexPath) ?? mainPath)
  }
  await Promise.all([...targets].map(syncBinary))
  const isCurrent = await readCodexHookFlagCheck()
  if (isEnabledNow() && codexHookFlagTableExists()) {
    pruneCodexHookFlagEntries((entry) => isCurrent(entry.flag), MAX_TABLE_ENTRIES)
  }
}

async function syncBinary(codexPath: string): Promise<void> {
  const key = normalizeRuntimePathForComparison(codexPath)
  const fingerprint = await fingerprintCodex(codexPath)
  const previous = known.get(key)
  // Why skip a cached failure: the same bytes would fail again; a new binary or a toggle retries.
  if (
    previous?.fingerprint === fingerprint &&
    (previous.failure !== null ||
      (previous.version !== null && readCodexHookFlagEntry(previous.version) !== null))
  ) {
    return
  }
  const result = await deriveCodexHookFlagEntry(
    codexPath,
    () => isEnabledNow() && codexHookFlagTableExists()
  )
  if (isEnabledNow()) {
    known.set(key, { fingerprint, version: result.codexVersion, failure: result.failure })
  }
}

// Why these fields: they change when an update or reinstall replaces the binary behind the path.
async function fingerprintCodex(codexPath: string): Promise<string> {
  try {
    const realPath = await realpath(codexPath)
    const info = await stat(realPath)
    return `${realPath}:${info.size}:${info.mtimeMs}:${info.ino}`
  } catch {
    return 'missing'
  }
}

// Why a codex-named absolute path only: the request file is text any launch may write.
function readRequestedCodexPath(codexPath: string | null): string | null {
  const probePath = codexPath && isAbsolute(codexPath) ? resolveCodexProbePath(codexPath) : null
  return probePath && /^codex(\.(exe|cmd))?$/i.test(basename(probePath)) ? probePath : null
}

function watchTable(): void {
  if (watcher || !config) {
    return
  }
  try {
    // Why any event: macOS can report a burst under the directory's own name, or none.
    const opened = config.watch(getCodexHookFlagTablePath(), () => {
      debounce ??= setTimeout(() => {
        debounce = null
        void syncCodexHookFlags()
      }, WATCH_DEBOUNCE_MS)
    })
    opened.on('error', (error) => {
      // Why not fatal: every pane spawn syncs, and the next sync opens a new watch.
      console.warn('[codex-hook-session] Codex hook flag request watch failed:', error)
      if (watcher === opened) {
        closeWatcher()
      }
    })
    opened.unref()
    watcher = opened
  } catch (error) {
    console.warn('[codex-hook-session] could not watch Codex hook flag requests:', error)
  }
}

function closeWatcher(): void {
  watcher?.close()
  watcher = null
  if (debounce) {
    clearTimeout(debounce)
    debounce = null
  }
}

export const _internals = {
  resetForTesting(): void {
    closeWatcher()
    config = null
    intent = false
    known.clear()
    pendingPaths.clear()
    running = null
    rerun = false
  }
}
