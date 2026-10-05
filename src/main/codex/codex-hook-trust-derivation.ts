import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '../../shared/child-process/run-process'
import { withCliRuntimeOnPath } from '../codex-cli/command'
import { CODEX_SHORT_LIVED_PROBE_APP_SERVER_ARGS } from '../codex-cli/codex-read-only-app-server-args'
import { collectHookListings, type CodexHookListing } from './codex-app-server-client'
import {
  isCodexAppServerUnsupportedError,
  runCodexAppServerSession
} from './codex-app-server-session'
import { buildCodexManagedHook, CODEX_EVENTS, CODEX_EVENT_LABEL } from './codex-hook-definition'
import type { CodexEventLabel } from './config-toml-trust'

/** Codex's hash per event label it lists for Orca's entry; an unlisted event gets no entry. */
export type CodexHookHashes = Readonly<Partial<Record<CodexEventLabel, string>>>

export type CodexHookTrustDerivation =
  | { codexVersion: string; hashes: CodexHookHashes; failure: null; transient: false }
  | { codexVersion: string | null; hashes: null; failure: string; transient: boolean }

const VERSION_TIMEOUT_MS = 5_000
// Why longer off the launch path: macOS assesses a new codex on its first run, measured at 10-12 s.
const DERIVE_VERSION_TIMEOUT_MS = 30_000
// Why: an app-server start with a cold sqlite takes ~4 s; this bounds a hung binary.
const DERIVE_TIMEOUT_MS = 30_000

/**
 * Asks one Codex binary for its hash of Orca's entry in each event, from a
 * throwaway CODEX_HOME whose hooks.json holds only that entry. Codex hashes the
 * hook alone, not its file or position, so the answer holds for every home.
 * Never throws; never reads or writes a real home.
 */
export async function deriveCodexHookHashes(
  codexPath: string,
  hookCommand: string,
  knownVersion?: string
): Promise<CodexHookTrustDerivation> {
  let codexVersion: string | null = knownVersion ?? null
  const failed = (failure: string, transient = false): CodexHookTrustDerivation => ({
    codexVersion,
    hashes: null,
    failure,
    transient
  })
  try {
    if (!codexVersion) {
      const probe = await probeCodexVersion(codexPath, DERIVE_VERSION_TIMEOUT_MS)
      codexVersion = probe.version
      if (!codexVersion) {
        return failed(`${codexPath} did not report its version`, probe.timedOut)
      }
    }
    const listings = await listScratchHomeHooks(codexPath, hookCommand)
    const hashes = readCodexHookHashes(listings, hookCommand)
    if (!hashes) {
      return failed(`${describeCodexVersion(codexVersion)} did not recognize Orca's status hook`)
    }
    return { codexVersion, hashes, failure: null, transient: false }
  } catch (error) {
    if (isCodexAppServerUnsupportedError(error)) {
      return failed(
        `${codexVersion ? describeCodexVersion(codexVersion) : codexPath} is too old for Orca status; update Codex`
      )
    }
    console.warn('[codex-hook-trust] could not derive Codex hook hashes:', error)
    return failed(error instanceof Error ? error.message : String(error), isTransient(error))
  }
}

// Why only these: a codex without the app-server, or one that exits early, would fail the same way every time.
function isTransient(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'CodexAppServerTimeoutError' ||
      ('syscall' in error && typeof error.syscall === 'string'))
  )
}

/** Orca's entries in every event, each alone in group 0, as hooks.json holds them. */
export function buildScratchHooksJson(hookCommand: string): string {
  const hooks = Object.fromEntries(
    CODEX_EVENTS.map((eventName) => [
      eventName,
      [{ hooks: [buildCodexManagedHook(hookCommand, eventName)] }]
    ])
  )
  return `${JSON.stringify({ hooks }, null, 2)}\n`
}

/** `hooks/list` for `codexHome`, or the default home when it is null; it changes no hook or config file. */
export async function listCodexHooks(
  codexPath: string,
  codexHome: string | null,
  cwd: string
): Promise<CodexHookListing[]> {
  const result = await runCodexAppServerSession(
    {
      command: codexPath,
      // Why the probe args: plugin startup can leave marketplace clones behind a short session.
      args: [...CODEX_SHORT_LIVED_PROBE_APP_SERVER_ARGS],
      cliPath: codexPath,
      ...(codexHome ? { env: { CODEX_HOME: codexHome } } : { envToDelete: ['CODEX_HOME'] }),
      timeoutMs: DERIVE_TIMEOUT_MS
    },
    (rpc) => rpc.request('hooks/list', { cwds: [cwd] })
  )
  return collectHookListings(result)
}

async function listScratchHomeHooks(
  codexPath: string,
  hookCommand: string
): Promise<CodexHookListing[]> {
  const scratchHome = await mkdtemp(join(tmpdir(), 'orca-codex-hook-trust-'))
  try {
    await writeFile(join(scratchHome, 'hooks.json'), buildScratchHooksJson(hookCommand))
    return await listCodexHooks(codexPath, scratchHome, scratchHome)
  } finally {
    await rm(scratchHome, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
  }
}

/** Codex's hash per event it lists Orca's entry for exactly once; null when it lists none. */
export function readCodexHookHashes(
  listings: readonly CodexHookListing[],
  hookCommand: string
): CodexHookHashes | null {
  const hashes: Partial<Record<CodexEventLabel, string>> = {}
  for (const eventName of CODEX_EVENTS) {
    const label = CODEX_EVENT_LABEL[eventName]
    const matches = listings.filter(
      (listing) => listing.command === hookCommand && listing.key.endsWith(`:${label}:0:0`)
    )
    if (matches.length === 1 && matches[0]!.currentHash) {
      hashes[label] = matches[0]!.currentHash
    }
  }
  return Object.keys(hashes).length > 0 ? hashes : null
}

/** "Codex 0.150.1" for `codex --version`'s "codex-cli 0.150.1"; other output as it is. */
export function describeCodexVersion(codexVersion: string): string {
  return codexVersion.replace(/^codex-cli\s+/, 'Codex ')
}

export async function probeCodexVersion(
  codexCommand: string,
  timeoutMs = VERSION_TIMEOUT_MS
): Promise<{ version: string | null; timedOut: boolean }> {
  // Why a throwaway home: even `--version` leaves a tmp/arg0 folder in its CODEX_HOME.
  const scratchHome = await mkdtemp(join(tmpdir(), 'orca-codex-version-'))
  try {
    const result = await runProcess({
      program: codexCommand,
      args: ['--version'],
      env: withCliRuntimeOnPath(codexCommand, { ...process.env, CODEX_HOME: scratchHome }),
      timeoutMs
    })
    const version = result.code === 0 ? result.stdout.trim() : ''
    return { version: version || null, timedOut: result.timedOut === true }
  } finally {
    await rm(scratchHome, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
  }
}
