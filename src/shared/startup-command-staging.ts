/**
 * Stages a long or multi-line startup command as a self-deleting script so the
 * host types only a short line that sources it.
 *
 * Why: the shell-ready marker fires before the line editor takes the TTY out of
 * canonical mode, so a typed line past MAX_CANON (1024 bytes on macOS) is
 * silently truncated, and macOS bash 3.2 reads each raw newline as Enter. Run
 * by the host that owns the PTY, at the moment it accepts the spawn.
 */
import { randomBytes } from 'node:crypto'
import { readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { quoteStartupArg } from './tui-agent-startup-shell'

/** Half of macOS MAX_CANON: a typed line this long survived every canonical-mode write measured. */
export const TYPED_STARTUP_COMMAND_BUDGET_BYTES = 512

export const STAGED_STARTUP_COMMAND_PREFIX = 'orca-launch-'

/** Which delivery ran for a spawn's typed startup line, decided by the host that owns the PTY. */
export type StartupLineDelivery = 'typed' | 'staged' | 'typed-after-stage-failed'

/** Age past which a staged script is a crash leftover rather than another host's in-flight launch. */
export const STAGED_STARTUP_COMMAND_STALE_MS = 60 * 60 * 1000

export type StartupCommandStaging = {
  /** What the host types: the command itself, or a short line sourcing the staged script. */
  command: string
  delivery: StartupLineDelivery
  /** Present while the script exists; the host unlinks it if the PTY exits before sourcing it. */
  scriptPath?: string
  /** Why staging failed, for the host's log. */
  failure?: string
}

// Why only these source the script: the staged body is Orca's portable quoting, verified literal in
// these. Any other shell (tcsh, nu, xonsh, pwsh...) runs an agent launch line Orca built through
// `/bin/sh` instead; a command the user wrote for that shell is typed as it always was.
const STAGING_SHELLS = new Set(['bash', 'zsh', 'sh', 'dash', 'fish', 'ksh', 'mksh'])

const encoder = new TextEncoder()

export function stagingShellName(shellPath: string | undefined): string | null {
  const name = shellPath?.split('/').pop()?.replace(/^-/, '').toLowerCase()
  return name && STAGING_SHELLS.has(name) ? name : null
}

/** Any C0 byte or DEL: no quoter escapes them, so a line editor reads them as keys. */
function hasControlByte(line: string): boolean {
  for (let i = 0; i < line.length; i += 1) {
    const code = line.charCodeAt(i)
    if (code < 0x20 || code === 0x7f) {
      return true
    }
  }
  return false
}

function stripSubmitTerminator(command: string): string {
  return command.replace(/(\r\n|\r|\n)$/, '')
}

export function shouldStageStartupCommand(args: {
  command: string
  shellPath: string | undefined
  platform: NodeJS.Platform
  /** An agent launch line Orca built with POSIX quoting, which sh can run in any shell. */
  orcaBuiltLine?: boolean
}): boolean {
  if (args.platform === 'win32') {
    return false
  }
  if (stagingShellName(args.shellPath) === null) {
    // Why every length: Orca's POSIX quoting is literal only in the shells above (tcsh doubles a
    // quoted backslash and expands `!!`), so another shell only ever sees the script's inert path.
    return args.orcaBuiltLine === true
  }
  const body = stripSubmitTerminator(args.command)
  return (
    hasControlByte(body) || encoder.encode(body).byteLength > TYPED_STARTUP_COMMAND_BUDGET_BYTES
  )
}

let staleSweepStarted = false

export function stageStartupCommand(args: {
  command: string
  shellPath: string | undefined
  orcaBuiltLine?: boolean
  platform?: NodeJS.Platform
  directory?: string
}): StartupCommandStaging {
  const platform = args.platform ?? process.platform
  if (!shouldStageStartupCommand({ ...args, platform })) {
    return { command: args.command, delivery: 'typed' }
  }
  const directory = args.directory ?? tmpdir()
  if (!staleSweepStarted) {
    staleSweepStarted = true
    // Why deferred: the sweep is crash recovery and must never delay this launch.
    setTimeout(() => sweepStaleStagedStartupCommands({ directory }), 0).unref?.()
  }
  const shellName = stagingShellName(args.shellPath)
  const scriptPath = join(
    directory,
    `${STAGED_STARTUP_COMMAND_PREFIX}${randomBytes(8).toString('hex')}.sh`
  )
  const quotedPath = quoteStartupArg(scriptPath, 'posix')
  try {
    // Why rm first: the shell keeps reading the open file, so the prompt-bearing script is gone
    // before the agent starts, however long it runs.
    writeFileSync(
      scriptPath,
      `command rm -f -- ${quotedPath}\n${stripSubmitTerminator(args.command)}\n`,
      { mode: 0o600, flag: 'wx' }
    )
  } catch (error) {
    return {
      command: args.command,
      delivery: 'typed-after-stage-failed',
      failure: error instanceof Error ? error.message : String(error)
    }
  }
  return {
    command:
      shellName === null
        ? `/bin/sh ${quotedPath}`
        : `${shellName === 'fish' ? 'source' : '.'} ${quotedPath}`,
    delivery: 'staged',
    scriptPath
  }
}

/**
 * The line the host prints to the terminal when staging failed: the full line it types instead may
 * leave the shell waiting for more input, and nothing else would tell the user why.
 */
export function startupStagingFailureNotice(staging: StartupCommandStaging): string | null {
  if (staging.failure === undefined) {
    return null
  }
  const reason = [...staging.failure]
    .map((char) => (char < ' ' || char === '\x7f' ? ' ' : char))
    .join('')
  return `\r\n[orca] Could not stage the launch command (${reason}); typed it in full. If the shell shows quote> or waits for more input, press Ctrl-C and launch again.\r\n`
}

/** For a PTY that exited, or was never typed into, before it sourced its script. */
export function discardStagedStartupCommand(staging: StartupCommandStaging | undefined): void {
  if (!staging?.scriptPath) {
    return
  }
  try {
    rmSync(staging.scriptPath, { force: true })
  } catch {
    // The age-gated sweep is the fallback.
  }
}

/** Removes scripts a crashed host left behind; age-gated so another instance's fresh launch survives. */
export function sweepStaleStagedStartupCommands(args: { directory?: string; now?: number }): void {
  const directory = args.directory ?? tmpdir()
  const now = args.now ?? Date.now()
  let names: string[]
  try {
    names = readdirSync(directory)
  } catch {
    return
  }
  for (const name of names) {
    if (!name.startsWith(STAGED_STARTUP_COMMAND_PREFIX) || !name.endsWith('.sh')) {
      continue
    }
    const path = join(directory, name)
    try {
      if (now - statSync(path).mtimeMs > STAGED_STARTUP_COMMAND_STALE_MS) {
        rmSync(path, { force: true })
      }
    } catch {
      // Raced another instance's sweep.
    }
  }
}
