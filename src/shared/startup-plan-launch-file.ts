/** How a startup plan carries a launch file: which prompts move into one, and what the line adds. */
import {
  MAX_INLINE_LAUNCH_PROMPT_CHARS,
  carryInLaunchFile,
  launchFileDirectoryPlaceholder,
  type LaunchFile
} from './launch-prompt-file'
import { TUI_AGENT_CONFIG } from './tui-agent-config'
import {
  isPosixStartupShell,
  quoteStartupArg,
  resolveStartupShell,
  type AgentStartupShell
} from './tui-agent-startup-shell'
import { hasControlByte, windowsTypedStartupLineFits } from './typed-startup-line'
import type { TuiAgent } from './tui-agent'

/**
 * Whether a Windows shell would damage `prompt` as one quoted argument; the closed rule is this plus
 * cmd's 8,191-character line cap (`carryLaunchPrompt`). No quoting keeps a control byte literal: cmd
 * types the line and a line break submits it early. PowerShell runs a short line from its argv, so
 * its damage is the hand-off to the agent (measured): legacy argument passing (5.1 always, 7.x into a
 * `.cmd` shim) splits at an inner `"` and turns a trailing `\` into `"`, and a shim's cmd.exe expands
 * `%NAME%`; a lone `%` stays literal.
 */
export function windowsShellDamagesPrompt(prompt: string, shell: AgentStartupShell): boolean {
  if (isPosixStartupShell(shell)) {
    return false
  }
  return (
    hasControlByte(prompt) ||
    (shell === 'powershell' &&
      (prompt.includes('"') || /%[^%]+%/.test(prompt) || prompt.endsWith('\\')))
  )
}

/** Why a prefill draft could not be launched, in the user's words, when the Windows shell is why. */
export function windowsDraftRefusal(draft: string, shell: AgentStartupShell): string | null {
  return windowsShellDamagesPrompt(draft.trim(), shell)
    ? "The host's Windows shell would break this draft on the agent's command line (it has a line " +
        'break or other control character, or on PowerShell a double quote, a %NAME% pair or a ' +
        'trailing backslash), so the agent was not started. Start it without the draft and paste ' +
        'the draft once it opens.'
    : null
}

type CarriedPlanArgs = {
  agent: TuiAgent
  prompt: string
  platform: NodeJS.Platform
  shell?: AgentStartupShell
  allowEmptyPromptLaunch?: boolean
  launchFile?: LaunchFile
  hostWritesLaunchFile?: boolean
  sensitive?: boolean
}

export function agentReadsLaunchFile(agent: TuiAgent): boolean {
  return TUI_AGENT_CONFIG[agent].readsLaunchFile === true
}

/**
 * Where a launch prompt rides, decided once for every launch path: on the line, which a POSIX host
 * stages when it is long or multi-line; in a launch file named by a pointer when the prompt is past
 * the argv ceiling, sensitive, damaged by a Windows shell, or past cmd's line cap; or, where no
 * launch file can be written (a paired host) or the agent is not known to read one, left in
 * `followupPrompt` for the paste after ready.
 */
export function carryLaunchPrompt<
  A extends CarriedPlanArgs,
  P extends { launchCommand: string; followupPrompt: string | null }
>(args: A, buildOnLine: (args: A) => P | null): P | null {
  const text = args.prompt.trim()
  const mode = TUI_AGENT_CONFIG[args.agent].promptInjectionMode
  if (!text || args.launchFile || mode === 'stdin-after-start') {
    return buildOnLine(args)
  }
  const readsEnv = mode === 'hermes-query'
  const pasteAfterReady = (): P | null => {
    const clean = buildOnLine({ ...args, prompt: '', allowEmptyPromptLaunch: true })
    return clean && { ...clean, followupPrompt: text }
  }
  const viaLaunchFile = (): P | null => {
    // Why: an agent not measured reading the file would stop on an approval or refuse the path.
    if (args.hostWritesLaunchFile === false || !agentReadsLaunchFile(args.agent)) {
      return pasteAfterReady()
    }
    const pointer = carryInLaunchFile(text, args.sensitive === true)
    return buildOnLine({ ...args, prompt: pointer.prompt, launchFile: pointer.launchFile })
  }
  const shell = resolveStartupShell(args.platform, args.shell)
  if (
    args.sensitive === true ||
    text.length > MAX_INLINE_LAUNCH_PROMPT_CHARS ||
    (!readsEnv && windowsShellDamagesPrompt(text, shell))
  ) {
    return viaLaunchFile()
  }
  const onLine = buildOnLine(args)
  if (!onLine || readsEnv) {
    // Hermes reads its prompt from the env and refuses one past that budget, counted in bytes; a
    // one-character query building proves the budget, not the command, refused it.
    return !onLine && readsEnv && buildOnLine({ ...args, prompt: '.' }) ? viaLaunchFile() : onLine
  }
  return args.platform === 'win32' && !windowsTypedStartupLineFits(onLine.launchCommand)
    ? viaLaunchFile()
    : onLine
}

/** The host writes the path inside this line's quoting, so the file carries which one it is. */
export function launchFileProps(launchFile: LaunchFile | undefined, shell: AgentStartupShell) {
  return launchFile ? { launchFile: { ...launchFile, quoting: shell } } : {}
}

/** The host puts the launch file's private directory where the placeholder is, like its path. */
export function launchFileDirectoryGrant(
  agent: TuiAgent,
  launchFile: LaunchFile | undefined,
  shell: AgentStartupShell
): string {
  const flag = TUI_AGENT_CONFIG[agent].launchFileDirectoryFlag
  if (!launchFile || !flag) {
    return ''
  }
  return ` ${quoteStartupArg(`${flag}=${launchFileDirectoryPlaceholder(launchFile.placeholder)}`, shell)}`
}
