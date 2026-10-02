/** Where a launch prompt rides: decided once here, for every launch path, and switched on by each. */
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
import { hasControlByte, typedStartupLineFits } from './typed-startup-line'
import type { TuiAgent } from './tui-agent'
import type { LaunchHost } from './launch-host'

/**
 * Whether a Windows shell would damage `prompt` as one quoted argument. No quoting keeps a control
 * byte literal: cmd types the line and a line break submits it early. PowerShell runs a short line
 * from its argv, so its damage is the hand-off to the agent (measured): legacy argument passing (5.1
 * always, 7.x into a `.cmd` shim) splits at an inner `"` and turns a trailing `\` into `"`, and a
 * shim's cmd.exe expands `%NAME%`; a lone `%` stays literal.
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

/**
 * Where a launch prompt went. Only the carried outcomes hold the plan to launch, so a caller must
 * switch on `carry` before it can launch anything, and cannot mistake a paste for a delivery.
 */
export type LaunchPromptPlan<P> =
  | { carry: 'none'; plan: P }
  | { carry: 'on-line'; plan: P }
  | { carry: 'launch-file'; plan: P; launchFile: LaunchFile }
  | { carry: 'paste-after-ready'; cleanPlan: P; text: string }

export type LaunchPromptCarry = LaunchPromptPlan<unknown>['carry']

/** Why a create that cannot paste after the agent is ready refuses a prompt that needs it. */
export function launchPromptNeedsPasteRefusal(
  agent: TuiAgent,
  created: 'terminal' | 'session'
): string {
  return TUI_AGENT_CONFIG[agent].promptInjectionMode === 'stdin-after-start'
    ? `${agent} takes its prompt only after it starts, so no ${created} was created. Start the ` +
        'agent and paste the prompt once it opens.'
    : `${agent} cannot take this prompt on its command line here (too long, or broken by the ` +
        `host's Windows shell), so no ${created} was created. Start the agent without it and ` +
        'paste the prompt once it opens.'
}

export type CarriedPlanArgs = {
  agent: TuiAgent
  prompt: string
  platform: NodeJS.Platform
  shell?: AgentStartupShell
  /** The file `prompt` already points at, when the caller wrote its own. */
  launchFile?: LaunchFile
  /** The host the launch runs on (`describeLaunchHost`). */
  host: LaunchHost
  /** Whether the caller pastes a prompt left for after the agent is ready. One that cannot still
   *  starts the agent with the prompt on its line, as main did. */
  canPasteAfterReady: boolean
}

export function agentReadsLaunchFile(agent: TuiAgent): boolean {
  return TUI_AGENT_CONFIG[agent].readsLaunchFile === true
}

/** cmd.exe's documented line cap, the smallest of the Windows shells Orca types into. */
export const WINDOWS_TYPED_LINE_MAX_CHARS = 8191

/**
 * Whether a Windows shell carries `prompt` exactly on `line`. Nothing stages a Windows line, so it
 * must hold no control byte, fit cmd's cap, and survive the shell's quoting (measured matrix:
 * `windowsShellDamagesPrompt`).
 */
function windowsLineCarriesExactly(prompt: string, line: string, shell: AgentStartupShell) {
  return (
    !hasControlByte(line) &&
    line.length <= WINDOWS_TYPED_LINE_MAX_CHARS &&
    !windowsShellDamagesPrompt(prompt, shell)
  )
}

/**
 * The one carry rule. The prompt rides the agent's line: a host that stages (POSIX, SSH, WSL)
 * stages it when it is long or multi-line, and a Windows host types it when its shell carries the
 * text exactly. It rides a launch file when it is past the argv ceiling, when a Windows line would
 * damage it, or past a paired host's typed budget. A launch file goes only to an agent measured
 * reading one, on a host that writes it. Otherwise the prompt is pasted once the agent is ready,
 * unless the host cannot prove the agent is in front to paste into or the caller has no paste:
 * then the line carries it, as main typed it.
 */
export function carryLaunchPrompt<A extends CarriedPlanArgs, P extends { launchCommand: string }>(
  args: A,
  buildLine: (args: A) => P | null
): LaunchPromptPlan<P> | null {
  const text = args.prompt.trim()
  const shell = resolveStartupShell(args.platform, args.shell)
  const clean = (): P | null => buildLine({ ...args, prompt: '', launchFile: undefined })
  if (!text) {
    const plan = clean()
    return plan && { carry: 'none', plan }
  }
  if (args.launchFile) {
    const plan = buildLine(args)
    return plan && { carry: 'launch-file', plan, launchFile: withQuoting(args.launchFile, shell) }
  }
  const pasteAfterReady = (): LaunchPromptPlan<P> | null => {
    const cleanPlan = clean()
    return cleanPlan && { carry: 'paste-after-ready', cleanPlan, text }
  }
  const mode = TUI_AGENT_CONFIG[args.agent].promptInjectionMode
  if (mode === 'stdin-after-start') {
    return pasteAfterReady()
  }
  const lineOrPaste = (): LaunchPromptPlan<P> | null => {
    const pasteIsSafe = args.host.provesAgentInFront && args.canPasteAfterReady
    const plan = pasteIsSafe ? null : buildLine(args)
    return plan ? { carry: 'on-line', plan } : pasteAfterReady()
  }
  const viaLaunchFile = (): LaunchPromptPlan<P> | null => {
    // Why: an agent not measured reading the file would stop on an approval or refuse the path.
    if (args.host.paired || !agentReadsLaunchFile(args.agent)) {
      return lineOrPaste()
    }
    const pointer = carryInLaunchFile(text, false)
    const plan = buildLine({ ...args, prompt: pointer.prompt, launchFile: pointer.launchFile })
    return (
      plan && { carry: 'launch-file', plan, launchFile: withQuoting(pointer.launchFile, shell) }
    )
  }
  if (text.length > MAX_INLINE_LAUNCH_PROMPT_CHARS) {
    return viaLaunchFile()
  }
  const plan = buildLine(args)
  const readsEnv = mode === 'hermes-query'
  if (!plan) {
    // Hermes reads its prompt from the env and refuses one past that budget, counted in bytes; a
    // one-character query building proves the budget, not the command, refused it.
    return readsEnv && buildLine({ ...args, prompt: '.' }) ? viaLaunchFile() : null
  }
  // Hermes's line never holds the text.
  if (readsEnv) {
    return { carry: 'on-line', plan }
  }
  if (args.platform === 'win32' && !windowsLineCarriesExactly(text, plan.launchCommand, shell)) {
    return viaLaunchFile()
  }
  // Why #24257's typed budget: an older paired host may type the line raw, truncated past it.
  if (args.host.paired && !typedStartupLineFits(plan.launchCommand)) {
    return viaLaunchFile()
  }
  return { carry: 'on-line', plan }
}

/** The host writes the path inside this line's quoting, so the file carries which one it is. */
function withQuoting(launchFile: LaunchFile, shell: AgentStartupShell): LaunchFile {
  return { ...launchFile, quoting: shell }
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
