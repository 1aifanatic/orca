import { basename, isAbsolute } from 'node:path'
import { runProcess } from '../../shared/child-process/run-process'
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'
import { resolveCodexCommand, withCliRuntimeOnPath } from '../codex-cli/command'
import { getManagedCommand, getManagedScriptPath } from './codex-hook-definition'
import {
  askCodexForHookSessionTrust,
  codexTrustsHookSessionFlag
} from './codex-hook-session-flag-lookup'
import { writeManagedScript } from '../agent-hooks/installer-utils'
import { getManagedScript } from './codex-hook-script'
import { ensureCodexCmdHookFlagGate } from './codex-cmd-hook-flag-gate'
import {
  isCodexHookFlagEntryName,
  publishCodexHookFlagEntry,
  pruneCodexHookFlagEntries,
  readCodexHookFlagEntry,
  resolveCodexProbePath,
  removeCodexHookFlagEntry,
  removeCodexHookFlagTable,
  type CodexHookFlagEntry,
  type CodexHookFlagRequest
} from './codex-hook-flag-table'
import { resolveWindowsShortPath } from '../windows/windows-short-path'
import {
  buildCodexHookDefinitionFlag,
  buildCodexHookSessionFlag,
  codexHookSessionFlagDefines
} from './codex-hook-session-flags'

/**
 * Derives the `-c` flag that lets Orca's status hook run approved without any
 * file in a Codex home, for one Codex binary, and publishes it to the flag
 * table under that binary's `codex --version`. Launches carry an entry only for
 * their own binary's version: another version might hash the hook differently
 * and put it up for review. Runs at app start, when the setting turns on, and
 * when a launch finds no entry for its version (a Codex update, a codex
 * installed later, a pane's own codex), so no launch waits for an Orca restart.
 */

const VERSION_TIMEOUT_MS = 5_000
// Why bounded: a binary that never yields a flag must stop costing app-server sessions.
const MAX_REQUEST_ATTEMPTS = 3
const REQUEST_RETRY_BASE_MS = 60_000

// Why a cap: one entry per Codex version ever seen would otherwise accumulate.
const MAX_TABLE_ENTRIES = 8

let generation = 0
let lastFailure: string | null = null
// Why per generation too: an ON after an opt-out must never join a run the opt-out voided.
const inFlight = new Map<string, Promise<CodexHookFlagEntry | null>>()
const pendingStarts = new Set<Promise<unknown>>()
const requestFailures = new Map<string, { count: number; retryAt: number }>()
let defaultCodexVersion: string | null = null

/**
 * Makes sure the table holds a current entry for `codexCommand` (default: the
 * codex this process resolves). Cheap when it does (one `--version` spawn).
 * Never throws, and never touches a user or managed Codex home.
 */
export function refreshCodexHookSessionFlags(
  codexCommand?: string
): Promise<CodexHookFlagEntry | null> {
  const command = codexCommand ?? resolveCodexCommand()
  const key = `${generation}\0${normalizeRuntimePathForComparison(command)}`
  const running = inFlight.get(key)
  if (running) {
    return running
  }
  const run = deriveAndPublish(command, generation, codexCommand === undefined)
    .catch((error: unknown) => {
      console.warn('[codex-hook-session] could not derive Codex hook flags:', error)
      return fail(error instanceof Error ? error.message : String(error))
    })
    .finally(() => {
      if (inFlight.get(key) === run) {
        inFlight.delete(key)
      }
    })
  inFlight.set(key, run)
  return run
}

/**
 * A launch found no entry for its version. Derives for the binary it named,
 * at most MAX_REQUEST_ATTEMPTS times per binary and version with backoff, so
 * a binary that can never yield a flag stops being asked. Null when skipped.
 */
export function handleCodexHookFlagRequest(
  request: CodexHookFlagRequest
): Promise<CodexHookFlagEntry | null> | null {
  const codexCommand = readRequestedCodexPath(request.codexPath) ?? resolveCodexCommand()
  const key = `${normalizeRuntimePathForComparison(codexCommand)}\0${request.codexVersion}`
  const failure = requestFailures.get(key)
  if (failure && (failure.count >= MAX_REQUEST_ATTEMPTS || Date.now() < failure.retryAt)) {
    return null
  }
  const startedIn = generation
  return refreshCodexHookSessionFlags(codexCommand).then((entry) => {
    if (entry?.codexVersion === request.codexVersion) {
      requestFailures.delete(key)
    } else if (startedIn === generation) {
      // Why only then: a run the opt-out voided says nothing about this binary.
      const count = (failure?.count ?? 0) + 1
      requestFailures.set(key, {
        count,
        retryAt: Date.now() + REQUEST_RETRY_BASE_MS * 2 ** (count - 1)
      })
    }
    return entry
  })
}

/**
 * App start: derives for the codex this process resolves once `ready` (shell
 * PATH hydration) settles, and counts as in flight from now, so a restored
 * resume can wait for it.
 */
export function refreshCodexHookSessionFlagsAfter(ready: Promise<unknown>): void {
  const run: Promise<unknown> = ready
    .catch(() => {})
    .then(() => refreshCodexHookSessionFlags())
    .finally(() => pendingStarts.delete(run))
  pendingStarts.add(run)
}

/** Waits, at most `timeoutMs`, for derivations already running or scheduled; never starts one. */
export async function awaitCodexHookSessionFlags(timeoutMs: number): Promise<void> {
  if (inFlight.size === 0 && pendingStarts.size === 0) {
    return
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    Promise.allSettled([...inFlight.values(), ...pendingStarts]),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs)
    })
  ])
  clearTimeout(timer)
}

/**
 * Opt-out: removes the table, so open panes run plain codex at their next
 * launch, and a derivation in flight publishes nothing.
 */
export function clearCodexHookSessionFlags(): void {
  generation += 1
  lastFailure = null
  requestFailures.clear()
  removeCodexHookFlagTable()
}

/** The version the codex this process resolves reported at its last derivation. */
export function getDefaultCodexHookFlagVersion(): string | null {
  return defaultCodexVersion
}

/** Drops entries whose definition this build no longer writes, and all but the newest few. */
export async function pruneCodexHookSessionFlags(): Promise<void> {
  const hookCommand = await resolveCarriableHookCommand().catch(() => null)
  pruneCodexHookFlagEntries(
    (entry) => hookCommand !== null && codexHookSessionFlagDefines(entry.flag, hookCommand),
    MAX_TABLE_ENTRIES
  )
}

/** Why the last derivation in this process published nothing, if it did not. */
export function getCodexHookSessionFlagFailure(): string | null {
  return lastFailure
}

function fail(detail: string): null {
  lastFailure = detail
  return null
}

// Why a codex-named absolute path only: the request file is text any launch may write.
function readRequestedCodexPath(codexPath: string | null): string | null {
  const probePath = codexPath && isAbsolute(codexPath) ? resolveCodexProbePath(codexPath) : null
  return probePath && /^codex(\.(exe|cmd))?$/i.test(basename(probePath)) ? probePath : null
}

// Why before publishing: a flag whose script is missing runs nothing, or fails every event on Windows.
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

async function deriveAndPublish(
  codexCommand: string,
  startedIn: number,
  isDefault: boolean
): Promise<CodexHookFlagEntry | null> {
  const codexVersion = await readCodexVersion(codexCommand)
  if (isDefault) {
    defaultCodexVersion = codexVersion
  }
  if (!codexVersion) {
    return fail(`${codexCommand} did not report its version`)
  }
  if (!isCodexHookFlagEntryName(codexVersion)) {
    return fail(`Codex version ${JSON.stringify(codexVersion)} cannot name a flag entry`)
  }
  const hookCommand = await resolveCarriableHookCommand()
  if (!hookCommand) {
    return fail('The hook script path cannot be carried in a Codex flag on this machine')
  }
  const published = readCodexHookFlagEntry(codexVersion)
  if (published && codexHookSessionFlagDefines(published.flag, hookCommand)) {
    lastFailure = null
    return published
  }
  // Why remove first: its approval belongs to a definition this build no longer writes.
  if (published) {
    removeCodexHookFlagEntry(codexVersion)
  }
  const trust = await askCodexForHookSessionTrust(codexCommand, hookCommand)
  const flag = trust ? buildCodexHookSessionFlag(hookCommand, trust) : null
  if (!flag) {
    return fail(`${codexVersion} did not report a hash for every hook event`)
  }
  if (!(await codexTrustsHookSessionFlag(codexCommand, flag, hookCommand))) {
    return fail(`${codexVersion} does not trust the hook's session-flag approval`)
  }
  const noDaemon = await readCodexAcceptsNoDaemon(codexCommand)
  // Why: an opt-out that landed mid-derivation must not be undone by its result.
  if (startedIn !== generation) {
    return null
  }
  if (!ensureCodexHookScripts()) {
    return fail('The Codex hook script could not be written')
  }
  const entry = { codexVersion, flag, noDaemon }
  if (!publishCodexHookFlagEntry(entry)) {
    return fail('Codex hooks are off for this profile')
  }
  lastFailure = null
  return entry
}

/**
 * The hook command a flag can carry. On Windows the flag holds no `"`, so a
 * profile path that needs the quoted cmd.exe spelling ("C:\Users\John Smith")
 * is carried by its 8.3 name, which the bare spelling accepts. Null when the
 * volume keeps no short names: those launches carry no hook, never an unapproved one.
 */
async function resolveCarriableHookCommand(): Promise<string | null> {
  const scriptPath = getManagedScriptPath()
  const command = getManagedCommand(scriptPath)
  if (buildCodexHookDefinitionFlag(command)) {
    return command
  }
  const shortPath = await resolveWindowsShortPath(scriptPath)
  const shortCommand = shortPath ? getManagedCommand(shortPath) : null
  return shortCommand && buildCodexHookDefinitionFlag(shortCommand) ? shortCommand : null
}

export async function readCodexVersion(codexCommand: string): Promise<string | null> {
  const result = await runProcess({
    program: codexCommand,
    args: ['--version'],
    env: withCliRuntimeOnPath(codexCommand, { ...process.env }),
    timeoutMs: VERSION_TIMEOUT_MS
  })
  const version = result.code === 0 ? result.stdout.trim() : ''
  return version || null
}

// Why recorded per entry: a launch with an entry then skips its own `--help` probe.
async function readCodexAcceptsNoDaemon(codexCommand: string): Promise<boolean> {
  const result = await runProcess({
    program: codexCommand,
    args: ['--help'],
    env: withCliRuntimeOnPath(codexCommand, { ...process.env }),
    timeoutMs: VERSION_TIMEOUT_MS
  }).catch(() => null)
  return result?.stdout.includes('--no-daemon') ?? false
}

export const _internals = {
  resetForTesting(): void {
    generation = 0
    lastFailure = null
    defaultCodexVersion = null
    inFlight.clear()
    pendingStarts.clear()
    requestFailures.clear()
  }
}
