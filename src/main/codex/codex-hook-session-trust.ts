import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { runProcess } from '../../shared/child-process/run-process'
import {
  isAgentStatusHooksEnabledForAgent,
  type AgentStatusHooksSettings
} from '../../shared/agent-status-hooks-setting'
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
import { getOrcaManagedCodexHomePath } from './codex-home-paths'
import { resolveWindowsShortPath } from '../windows/windows-short-path'
import {
  buildCodexHookDefinitionFlag,
  buildCodexHookSessionFlag,
  type CodexHookSessionTrust
} from './codex-hook-session-flags'

/**
 * What a Codex launch appends so Orca's status hook runs approved without any
 * file in a Codex home: the `-c` argument, and the `codex --version` output it
 * was derived for. The shell's codex function carries the argument only when
 * its own binary reports the same version; any other binary might hash the
 * hook differently and would put it up for review.
 */
export type CodexHookSessionFlags = {
  flag: string
  codexVersion: string
}

type Memo = {
  version: 1
  platform: string
  codexVersion: string
  command: string
  trust: CodexHookSessionTrust
}

// Why: an app-server start with a cold sqlite takes ~4 s; this bounds a hung binary.
const DERIVE_TIMEOUT_MS = 30_000
const VERSION_TIMEOUT_MS = 5_000

let current: CodexHookSessionFlags | null = null
let inFlight: Promise<CodexHookSessionFlags | null> | null = null

/** The flags a pane spawned now carries, or null when none are ready. */
export function getCodexHookSessionFlags(): CodexHookSessionFlags | null {
  return current
}

/**
 * Re-derives the flags for the Codex this process resolves. Cheap when the
 * version matches the memo (one `--version` spawn); otherwise asks Codex for
 * each event's key and hash in a throwaway CODEX_HOME. Never throws, and never
 * touches a user or managed Codex home.
 */
export function refreshCodexHookSessionFlags(): Promise<CodexHookSessionFlags | null> {
  inFlight ??= deriveCurrentFlags()
    .catch((error: unknown) => {
      console.warn('[codex-hook-session] could not derive Codex hook flags:', error)
      return null
    })
    .then((flags) => {
      current = flags
      return flags
    })
    .finally(() => {
      inFlight = null
    })
  return inFlight
}

/** The flags a launch carries under these settings: none while Codex hooks are off. */
export function getCodexHookSessionFlagsForSettings(
  settings: AgentStatusHooksSettings
): CodexHookSessionFlags | null {
  return isAgentStatusHooksEnabledForAgent(settings, 'codex') ? current : null
}

export function clearCodexHookSessionFlags(): void {
  current = null
}

async function deriveCurrentFlags(): Promise<CodexHookSessionFlags | null> {
  const codexCommand = resolveCodexCommand()
  const codexVersion = await readCodexVersion(codexCommand)
  if (!codexVersion) {
    return null
  }
  const hookCommand = await resolveCarriableHookCommand()
  if (!hookCommand) {
    return null
  }
  const memo = await readMemo()
  // Why re-derive on any mismatch: a memo is only a saved answer, never the source of truth.
  const memoFlag =
    memo?.platform === process.platform &&
    memo.codexVersion === codexVersion &&
    memo.command === hookCommand
      ? buildCodexHookSessionFlag(hookCommand, memo.trust)
      : null
  if (memoFlag) {
    return { flag: memoFlag, codexVersion }
  }
  const trust = await askCodexForHookSessionTrust(codexCommand, hookCommand)
  const flag = trust ? buildCodexHookSessionFlag(hookCommand, trust) : null
  if (!trust || !flag) {
    return null
  }
  await writeMemo({
    version: 1,
    platform: process.platform,
    codexVersion,
    command: hookCommand,
    trust
  })
  return { flag, codexVersion }
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

/** Codex's key and hash for each event of `hookCommand`, asked in a throwaway CODEX_HOME. */
export async function askCodexForHookSessionTrust(
  codexCommand: string,
  hookCommand: string
): Promise<CodexHookSessionTrust | null> {
  const definition = buildCodexHookDefinitionFlag(hookCommand)
  if (!definition) {
    return null
  }
  // Why a throwaway home: Codex computes the hash with no file or position in it,
  // so the answer holds for every home, and no real home is read or written.
  const scratchHome = await mkdtemp(join(tmpdir(), 'orca-codex-hook-trust-'))
  try {
    const listing = await runCodexAppServerSession(
      {
        command: codexCommand,
        // Why the probe args: plugin startup can leave marketplace clones behind a short session.
        args: ['-c', definition, ...CODEX_SHORT_LIVED_PROBE_APP_SERVER_ARGS],
        cliPath: codexCommand,
        env: { CODEX_HOME: scratchHome },
        timeoutMs: DERIVE_TIMEOUT_MS
      },
      (rpc) => rpc.request('hooks/list', { cwds: [scratchHome] })
    )
    return readSessionFlagTrust(collectHookListings(listing), hookCommand)
  } finally {
    await rm(scratchHome, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
  }
}

/** Codex's key and hash per managed event, or null unless every event is reported once. */
export function readSessionFlagTrust(
  listings: readonly CodexHookListing[],
  hookCommand: string
): CodexHookSessionTrust | null {
  const entries = CODEX_EVENTS.map((eventName) => {
    const label = CODEX_EVENT_LABEL[eventName]
    const matches = listings.filter(
      (listing) =>
        listing.source === 'sessionFlags' &&
        listing.command === hookCommand &&
        listing.key.endsWith(`:${label}:0:0`)
    )
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

function getMemoPath(): string {
  return join(dirname(getOrcaManagedCodexHomePath()), 'codex-hook-session-trust.json')
}

async function readMemo(): Promise<Memo | null> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(getMemoPath(), 'utf-8'))
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Reflect.get(parsed, 'version') !== 1) {
    return null
  }
  const platform: unknown = Reflect.get(parsed, 'platform')
  const codexVersion: unknown = Reflect.get(parsed, 'codexVersion')
  const command: unknown = Reflect.get(parsed, 'command')
  const trust = readTrustRecord(Reflect.get(parsed, 'trust'))
  return typeof platform === 'string' &&
    typeof codexVersion === 'string' &&
    typeof command === 'string' &&
    trust
    ? { version: 1, platform, codexVersion, command, trust }
    : null
}

async function writeMemo(memo: Memo): Promise<void> {
  try {
    await writeFile(getMemoPath(), `${JSON.stringify(memo, null, 2)}\n`, 'utf-8')
  } catch (error) {
    // Why: the memo only saves the next start a Codex session.
    console.warn('[codex-hook-session] could not save Codex hook trust memo:', error)
  }
}

export const _internals = {
  resetForTesting(): void {
    current = null
    inFlight = null
  }
}
