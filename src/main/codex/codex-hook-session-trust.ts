import { runProcess } from '../../shared/child-process/run-process'
import { withCliRuntimeOnPath } from '../codex-cli/command'
import { getManagedCommand, getManagedScriptPath } from './codex-hook-definition'
import {
  askCodexForHookSessionTrust,
  codexTrustsHookSessionFlag
} from './codex-hook-session-flag-lookup'
import {
  isCodexHookFlagEntryName,
  publishCodexHookFlagEntry,
  readCodexHookFlagEntry,
  removeCodexHookFlagEntry,
  type CodexHookFlagEntry
} from './codex-hook-flag-table'
import { resolveWindowsShortPath } from '../windows/windows-short-path'
import {
  buildCodexHookDefinitionFlag,
  buildCodexHookSessionFlag,
  codexHookSessionFlagDefines
} from './codex-hook-session-flags'

/**
 * Derives, for one Codex binary, the `-c` flag that lets Orca's status hook
 * run approved without any file in a Codex home, and publishes it to the flag
 * table under that binary's `codex --version`. Launches carry an entry only
 * for their own binary's version: another version might hash the hook
 * differently and put it up for review. Holds no state; syncCodexHookFlags
 * decides when to call it.
 */

const VERSION_TIMEOUT_MS = 5_000
// Why retried: an 8.3 lookup that failed may only have timed out on a loaded machine.
const UNCARRIABLE_RETRY_MS = 60_000

type CodexHookFlagDerivation = {
  codexVersion: string | null
  entry: CodexHookFlagEntry | null
  /** Why no entry, when the binary itself is the reason; null otherwise. */
  failure: string | null
  /** The failure may pass on its own (a timeout), so it is worth asking again soon. */
  transient: boolean
}

let carriable: { scriptPath: string; command: Promise<string | null>; retryAt: number } | null =
  null

/** Never throws. `canPublish` is checked right before the write: Codex hooks may have turned off meanwhile. */
export async function deriveCodexHookFlagEntry(
  codexPath: string,
  canPublish: () => boolean
): Promise<CodexHookFlagDerivation> {
  let codexVersion: string | null = null
  const failed = (failure: string, transient = false): CodexHookFlagDerivation => ({
    codexVersion,
    entry: null,
    failure,
    transient
  })
  const done = (entry: CodexHookFlagEntry | null): CodexHookFlagDerivation => ({
    codexVersion,
    entry,
    failure: null,
    transient: false
  })
  try {
    const probe = await probeCodexVersion(codexPath)
    codexVersion = probe.version
    if (!codexVersion) {
      return failed(`${codexPath} did not report its version`, probe.timedOut)
    }
    if (!isCodexHookFlagEntryName(codexVersion)) {
      return failed(`Codex version ${JSON.stringify(codexVersion)} cannot name a flag entry`)
    }
    const hookCommand = await resolveCarriableHookCommand()
    if (!hookCommand) {
      return failed('The hook script path cannot be carried in a Codex flag on this machine', true)
    }
    const published = readCodexHookFlagEntry(codexVersion)
    if (published && codexHookSessionFlagDefines(published.flag, hookCommand)) {
      return done(published)
    }
    // Why remove first: its approval belongs to a definition this build no longer writes.
    if (published) {
      removeCodexHookFlagEntry(codexVersion)
    }
    const trust = await askCodexForHookSessionTrust(codexPath, hookCommand)
    const flag = trust ? buildCodexHookSessionFlag(hookCommand, trust) : null
    if (!flag) {
      return failed(`${codexVersion} did not report a hash for every hook event`)
    }
    if (!(await codexTrustsHookSessionFlag(codexPath, flag, hookCommand))) {
      return failed(`${codexVersion} does not trust the hook's session-flag approval`)
    }
    const entry = { codexVersion, flag, noDaemon: await readCodexAcceptsNoDaemon(codexPath) }
    // Why checked here, synchronously with the write: an opt-out meanwhile must win.
    return done(canPublish() && publishCodexHookFlagEntry(entry) ? entry : null)
  } catch (error) {
    console.warn('[codex-hook-session] could not derive Codex hook flags:', error)
    return failed(error instanceof Error ? error.message : String(error), isTransient(error))
  }
}

// Why only these: a codex without the app-server, or one that exits early, would fail the same way every time.
function isTransient(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'CodexAppServerTimeoutError' ||
      typeof Reflect.get(error, 'syscall') === 'string')
  )
}

/**
 * Whether `flag` is one this build would write today; others are pruned and
 * re-derived. Null while this build's definition is unknown: then nothing is pruned.
 */
export async function readCodexHookFlagCheck(): Promise<((flag: string) => boolean) | null> {
  const hookCommand = await resolveCarriableHookCommand()
  return hookCommand === null ? null : (flag) => codexHookSessionFlagDefines(flag, hookCommand)
}

/**
 * The hook command a flag can carry. On Windows the flag holds no `"`, so a
 * profile path that needs the quoted cmd.exe spelling ("C:\Users\John Smith")
 * is carried by its 8.3 name, which the bare spelling accepts. Null when the
 * volume keeps no short names: those launches carry no hook, never an unapproved one.
 */
// Why remembered: the script path is fixed for the process, and on Windows the 8.3 lookup spawns cmd.exe.
async function resolveCarriableHookCommand(): Promise<string | null> {
  const scriptPath = getManagedScriptPath()
  if (carriable?.scriptPath === scriptPath && Date.now() < carriable.retryAt) {
    return carriable.command
  }
  const command = lookupCarriableHookCommand(scriptPath).catch(() => null)
  const current = { scriptPath, command, retryAt: Number.POSITIVE_INFINITY }
  carriable = current
  if ((await command) === null) {
    current.retryAt = Date.now() + UNCARRIABLE_RETRY_MS
  }
  return command
}

async function lookupCarriableHookCommand(scriptPath: string): Promise<string | null> {
  const command = getManagedCommand(scriptPath)
  if (buildCodexHookDefinitionFlag(command)) {
    return command
  }
  const shortPath = await resolveWindowsShortPath(scriptPath)
  const shortCommand = shortPath ? getManagedCommand(shortPath) : null
  return shortCommand && buildCodexHookDefinitionFlag(shortCommand) ? shortCommand : null
}

export async function readCodexVersion(codexCommand: string): Promise<string | null> {
  return (await probeCodexVersion(codexCommand)).version
}

async function probeCodexVersion(
  codexCommand: string
): Promise<{ version: string | null; timedOut: boolean }> {
  const result = await runProcess({
    program: codexCommand,
    args: ['--version'],
    env: withCliRuntimeOnPath(codexCommand, { ...process.env }),
    timeoutMs: VERSION_TIMEOUT_MS
  })
  const version = result.code === 0 ? result.stdout.trim() : ''
  return { version: version || null, timedOut: result.timedOut === true }
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
    carriable = null
  }
}
