/**
 * Writes a launch file on the host that owns the PTY and puts its path where the
 * launch line and env name the placeholder. The file exists before any line
 * naming it is typed.
 */
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, posix } from 'node:path'
import {
  describeLaunchFileUnavailable,
  launchFileDirectoryPlaceholder,
  type LaunchFile
} from './launch-prompt-file'
import { quoteStartupArg, type AgentStartupShell } from './tui-agent-startup-shell'
import { typedStartupLineFits } from './typed-startup-line'
import type { WslLaunchDirectory } from './wsl-launch-directory'

const LAUNCH_FILE_DIR_PREFIX = 'orca-launch-file-'
const LAUNCH_FILE_NAME = 'task-context.md'

/** A running agent may re-read its task file, so leftovers get a day, not an hour. */
export const LAUNCH_FILE_STALE_MS = 24 * 60 * 60 * 1000

// Characters one of the three quotings ends or expands on: `'` (POSIX, PowerShell, which also
// honours the typographic single quotes), `"` and `%` (cmd).
const QUOTE_SENSITIVE_PATH_CHARACTER = /['"%\u2018-\u201b]/

function hasControlCharacter(value: string): boolean {
  return [...value].some((char) => char < ' ' || char === '\x7f')
}

/**
 * The path as it must read inside the quoted run that held the placeholder, or null when that
 * quoting cannot carry it. Letters in any script are literal in all three quotings.
 */
export function launchFilePathInQuotedRun(
  path: string,
  quoting: AgentStartupShell | undefined,
  platform: NodeJS.Platform
): string | null {
  // No quoting keeps a typed line break or other control byte literal.
  if (hasControlCharacter(path)) {
    return null
  }
  if (quoting === 'posix') {
    // The same escapes the POSIX quoter uses between its single-quoted runs.
    return [...path]
      .map((char) => (char === "'" ? `'"'"'` : char === '\\' ? `'"\\\\"'` : char))
      .join('')
  }
  if (quoting === 'cmd') {
    // No Windows path holds `"`; the quoter breaks `%` out of the run.
    return path.includes('"') ? null : quoteStartupArg(path, 'cmd').slice(1, -1)
  }
  if (quoting === 'powershell') {
    return quoteStartupArg(path, 'powershell').slice(1, -1)
  }
  const sensitive =
    QUOTE_SENSITIVE_PATH_CHARACTER.test(path) || (platform !== 'win32' && path.includes('\\'))
  return sensitive ? null : path
}

export class LaunchFileUnavailableError extends Error {
  constructor(reason: string) {
    super(describeLaunchFileUnavailable(reason))
  }
}

export type WrittenLaunchFile = {
  /** Where the host wrote it, and removes it from. */
  directory: string
  /** The file as the line and the agent name it (a Linux path for a WSL session). */
  path: string
  command?: string
  env?: Record<string, string>
}

const sweptBaseDirectories = new Set<string>()

/** Throws LaunchFileUnavailableError rather than type a line naming a file that is not there. */
export function writeLaunchFile(args: {
  launchFile: LaunchFile
  command?: string
  env?: Record<string, string>
  platform?: NodeJS.Platform
  baseDirectory?: string
  /** A WSL session's: written over UNC, named in the line by its Linux path. */
  wslDirectory?: WslLaunchDirectory
}): WrittenLaunchFile {
  const wsl = args.wslDirectory
  const platform = wsl ? 'linux' : (args.platform ?? process.platform)
  const baseDirectory = wsl?.windowsPath ?? args.baseDirectory ?? tmpdir()
  if (!sweptBaseDirectories.has(baseDirectory)) {
    sweptBaseDirectories.add(baseDirectory)
    // Why deferred: the sweep is crash recovery and must never delay this launch.
    setTimeout(() => sweepStaleLaunchFiles({ baseDirectory }), 0).unref?.()
  }
  let directory: string | undefined
  try {
    if (wsl) {
      mkdirSync(baseDirectory, { recursive: true })
    }
    // Why realpath: an agent matches its read grant against the resolved path (macOS $TMPDIR sits
    // under /var -> /private/var), so the pointer and the granted directory both name that form.
    // A UNC path into WSL is named by its Linux path instead, which the distro resolves itself.
    const created = mkdtempSync(join(baseDirectory, LAUNCH_FILE_DIR_PREFIX))
    directory = wsl ? created : realpathSync(created)
    const launchDirectory = wsl ? posix.join(wsl.linuxPath, basename(created)) : directory
    const path = (wsl ? posix.join : join)(launchDirectory, LAUNCH_FILE_NAME)
    const quotedPath = launchFilePathInQuotedRun(path, args.launchFile.quoting, platform)
    const quotedDirectory = launchFilePathInQuotedRun(
      launchDirectory,
      args.launchFile.quoting,
      platform
    )
    if (quotedPath === null || quotedDirectory === null) {
      throw new LaunchFileUnavailableError('temp directory path cannot be quoted')
    }
    writeFileSync(join(directory, LAUNCH_FILE_NAME), args.launchFile.content, {
      mode: 0o600,
      flag: 'wx'
    })
    const directoryPlaceholder = launchFileDirectoryPlaceholder(args.launchFile.placeholder)
    // Why functions: a string replacement would expand `$'` and `$&` inside the path.
    const substitute = (value: string, filePath: string, directoryPath: string): string =>
      value
        .replaceAll(args.launchFile.placeholder, () => filePath)
        .replaceAll(directoryPlaceholder, () => directoryPath)
    return {
      directory,
      path,
      ...(args.command !== undefined
        ? { command: substitute(args.command, quotedPath, quotedDirectory) }
        : {}),
      ...(args.env
        ? {
            env: Object.fromEntries(
              Object.entries(args.env).map(([key, value]) => [
                key,
                substitute(value, path, launchDirectory)
              ])
            )
          }
        : {})
    }
  } catch (error) {
    if (directory) {
      rmSync(directory, { recursive: true, force: true })
    }
    throw error instanceof LaunchFileUnavailableError
      ? error
      : new LaunchFileUnavailableError(error instanceof Error ? error.message : String(error))
  }
}

/**
 * The write site's launch file for a spawn. A WSL session writes it into the distro, and refuses
 * when the distro directory is unknown and a file or a staged line needs it: a Windows path means
 * nothing to an agent in the distro, and a long line typed raw is cut or submitted early.
 */
export function writeSpawnLaunchFile(args: {
  launchFile?: LaunchFile
  command?: string
  env?: Record<string, string>
  orcaBuiltLine: boolean
  wslDistro: string | null | undefined
  wslDirectory: WslLaunchDirectory | undefined
}): WrittenLaunchFile | undefined {
  const wslDirectory = args.wslDistro ? args.wslDirectory : undefined
  const needsDirectory =
    args.launchFile !== undefined ||
    (args.orcaBuiltLine && args.command !== undefined && !typedStartupLineFits(args.command))
  if (args.wslDistro && needsDirectory && wslDirectory?.distro !== args.wslDistro) {
    throw new LaunchFileUnavailableError("the WSL distro's home directory could not be reached")
  }
  return args.launchFile
    ? writeLaunchFile({
        launchFile: args.launchFile,
        command: args.command,
        env: args.env,
        wslDirectory
      })
    : undefined
}

export function removeLaunchFile(written: WrittenLaunchFile | undefined): void {
  if (!written) {
    return
  }
  try {
    rmSync(written.directory, { recursive: true, force: true })
  } catch {
    // The age-gated sweep is the fallback.
  }
}

/** Removes launch files a crashed host left behind; age-gated so a live agent's file survives. */
export function sweepStaleLaunchFiles(args: { baseDirectory?: string; now?: number }): void {
  const baseDirectory = args.baseDirectory ?? tmpdir()
  const now = args.now ?? Date.now()
  let names: string[]
  try {
    names = readdirSync(baseDirectory)
  } catch {
    return
  }
  for (const name of names) {
    if (!name.startsWith(LAUNCH_FILE_DIR_PREFIX)) {
      continue
    }
    const directory = join(baseDirectory, name)
    try {
      if (now - statSync(directory).mtimeMs > LAUNCH_FILE_STALE_MS) {
        rmSync(directory, { recursive: true, force: true })
      }
    } catch {
      // Raced another instance's sweep.
    }
  }
}
