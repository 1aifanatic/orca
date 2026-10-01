import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join } from 'node:path'
import { runProcess } from '../../shared/child-process/run-process'
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'
import { resolveCodexCommand, withCliRuntimeOnPath } from '../codex-cli/command'
import { CODEX_SHORT_LIVED_PROBE_APP_SERVER_ARGS } from '../codex-cli/codex-read-only-app-server-args'
import { collectHookListings, type CodexHookListing } from './codex-app-server-client'
import { runCodexAppServerSession } from './codex-app-server-session'
import {
  CODEX_EVENTS,
  CODEX_EVENT_LABEL,
  getManagedCommand,
  getManagedScriptPath
} from './codex-hook-definition'
import {
  clearCodexHookFlagTable,
  isCodexHookFlagEntryName,
  publishCodexHookFlagEntry,
  readCodexHookFlagEntry,
  removeCodexHookFlagEntry,
  type CodexHookFlagEntry,
  type CodexHookFlagRequest
} from './codex-hook-flag-table'
import { resolveWindowsShortPath } from '../windows/windows-short-path'
import {
  buildCodexHookDefinitionFlag,
  buildCodexHookSessionFlag,
  codexHookSessionFlagDefines,
  type CodexHookSessionTrust
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

// Why: an app-server start with a cold sqlite takes ~4 s; this bounds a hung binary.
const DERIVE_TIMEOUT_MS = 30_000
const VERSION_TIMEOUT_MS = 5_000
// Why bounded: a binary that never yields a flag must stop costing app-server sessions.
const MAX_REQUEST_ATTEMPTS = 3
const REQUEST_RETRY_BASE_MS = 60_000

let generation = 0
let lastFailure: string | null = null
const inFlight = new Map<string, Promise<CodexHookFlagEntry | null>>()
const requestFailures = new Map<string, { count: number; retryAt: number }>()

/**
 * Makes sure the table holds a current entry for `codexCommand` (default: the
 * codex this process resolves). Cheap when it does (one `--version` spawn).
 * Never throws, and never touches a user or managed Codex home.
 */
export function refreshCodexHookSessionFlags(
  codexCommand: string = resolveCodexCommand()
): Promise<CodexHookFlagEntry | null> {
  const key = normalizeRuntimePathForComparison(codexCommand)
  const running = inFlight.get(key)
  if (running) {
    return running
  }
  const run = deriveAndPublish(codexCommand, generation)
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
  return refreshCodexHookSessionFlags(codexCommand).then((entry) => {
    if (entry?.codexVersion === request.codexVersion) {
      requestFailures.delete(key)
    } else {
      const count = (failure?.count ?? 0) + 1
      requestFailures.set(key, {
        count,
        retryAt: Date.now() + REQUEST_RETRY_BASE_MS * 2 ** (count - 1)
      })
    }
    return entry
  })
}

/** Waits, at most `timeoutMs`, for derivations already running; never starts one. */
export async function awaitCodexHookSessionFlags(timeoutMs: number): Promise<void> {
  if (inFlight.size === 0) {
    return
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    Promise.allSettled(inFlight.values()),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs)
    })
  ])
  clearTimeout(timer)
}

/** Opt-out: open panes stop carrying at their next launch, and a derivation in flight publishes nothing. */
export function clearCodexHookSessionFlags(): void {
  generation += 1
  lastFailure = null
  requestFailures.clear()
  clearCodexHookFlagTable()
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
  return codexPath && isAbsolute(codexPath) && /^codex(\.(exe|cmd))?$/i.test(basename(codexPath))
    ? codexPath
    : null
}

async function deriveAndPublish(
  codexCommand: string,
  startedIn: number
): Promise<CodexHookFlagEntry | null> {
  const codexVersion = await readCodexVersion(codexCommand)
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
  const entry = { codexVersion, flag, noDaemon }
  publishCodexHookFlagEntry(entry)
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

/** Codex's key and hash for each event of `hookCommand`, asked in a throwaway CODEX_HOME. */
export async function askCodexForHookSessionTrust(
  codexCommand: string,
  hookCommand: string
): Promise<CodexHookSessionTrust | null> {
  const definition = buildCodexHookDefinitionFlag(hookCommand)
  if (!definition) {
    return null
  }
  const listings = await listSessionFlagHooks(codexCommand, definition)
  return readSessionFlagTrust(listings, hookCommand)
}

/** Whether Codex lists every event of the complete flag (definition plus approval) as trusted and enabled. */
export async function codexTrustsHookSessionFlag(
  codexCommand: string,
  flag: string,
  hookCommand: string
): Promise<boolean> {
  const listings = await listSessionFlagHooks(codexCommand, flag)
  return CODEX_EVENTS.every((eventName) => {
    const matches = matchSessionFlagEvent(listings, hookCommand, CODEX_EVENT_LABEL[eventName])
    return (
      matches.length === 1 && matches[0].trustStatus === 'trusted' && matches[0].enabled === true
    )
  })
}

async function listSessionFlagHooks(
  codexCommand: string,
  flag: string
): Promise<CodexHookListing[]> {
  // Why a throwaway home: Codex computes the hash with no file or position in it,
  // so the answer holds for every home, and no real home is read or written.
  const scratchHome = await mkdtemp(join(tmpdir(), 'orca-codex-hook-trust-'))
  try {
    const listing = await runCodexAppServerSession(
      {
        command: codexCommand,
        // Why the probe args: plugin startup can leave marketplace clones behind a short session.
        args: ['-c', flag, ...CODEX_SHORT_LIVED_PROBE_APP_SERVER_ARGS],
        cliPath: codexCommand,
        env: { CODEX_HOME: scratchHome },
        timeoutMs: DERIVE_TIMEOUT_MS
      },
      (rpc) => rpc.request('hooks/list', { cwds: [scratchHome] })
    )
    return collectHookListings(listing)
  } finally {
    await rm(scratchHome, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
  }
}

function matchSessionFlagEvent(
  listings: readonly CodexHookListing[],
  hookCommand: string,
  label: string
): CodexHookListing[] {
  return listings.filter(
    (listing) =>
      listing.source === 'sessionFlags' &&
      listing.command === hookCommand &&
      listing.key.endsWith(`:${label}:0:0`)
  )
}

/** Codex's key and hash per managed event, or null unless every event is reported once. */
export function readSessionFlagTrust(
  listings: readonly CodexHookListing[],
  hookCommand: string
): CodexHookSessionTrust | null {
  const entries = CODEX_EVENTS.map((eventName) => {
    const label = CODEX_EVENT_LABEL[eventName]
    const matches = matchSessionFlagEvent(listings, hookCommand, label)
    return matches.length === 1
      ? ([label, { key: matches[0].key, trustedHash: matches[0].currentHash }] as const)
      : null
  })
  return readTrustRecord(Object.fromEntries(entries.filter((entry) => entry !== null)))
}

/** A complete per-event trust record from untrusted input, or null. */
function readTrustRecord(value: unknown): CodexHookSessionTrust | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const record: Record<string, { key: string; trustedHash: string }> = {}
  for (const eventName of CODEX_EVENTS) {
    const label = CODEX_EVENT_LABEL[eventName]
    const entry: unknown = Reflect.get(value, label)
    const key: unknown = entry && typeof entry === 'object' ? Reflect.get(entry, 'key') : null
    const trustedHash: unknown =
      entry && typeof entry === 'object' ? Reflect.get(entry, 'trustedHash') : null
    if (typeof key !== 'string' || typeof trustedHash !== 'string') {
      return null
    }
    record[label] = { key, trustedHash }
  }
  return record
}

export const _internals = {
  resetForTesting(): void {
    generation = 0
    lastFailure = null
    inFlight.clear()
    requestFailures.clear()
  }
}
