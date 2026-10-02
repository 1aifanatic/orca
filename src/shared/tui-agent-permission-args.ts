import type { GlobalSettings } from './global-settings-types'
import {
  agentHasPermissionMode,
  agentPermissionOptionNames,
  resolveAgentPermissionMode,
  YOLO_TUI_AGENT_ARGS,
  YOLO_TUI_AGENT_ENV,
  type AgentPermissionMode
} from './tui-agent-permissions'
import {
  resolveStartupShell,
  tokenizeStartupCommand,
  type AgentStartupShell,
  type StartupCommandTokens
} from './tui-agent-startup-shell'
import type { AgentLaunchProfileSettings } from './tui-agent-launch-defaults'
import type { CommandTokenSpan } from './commit-message-prompt'
import type { TuiAgent } from './tui-agent'
import { resolveLocalWindowsAgentStartupShell } from './windows-terminal-shell'

// Reads permission settings typed into an agent's free-text Arguments and env.

/** Other spellings of an agent's bypass that users type into Arguments. */
const BYPASS_ARG_ALIASES: Partial<Record<TuiAgent, readonly string[]>> = {
  claude: ['--permission-mode bypassPermissions', '--permission-mode=bypassPermissions'],
  'claude-agent-teams': [
    '--permission-mode bypassPermissions',
    '--permission-mode=bypassPermissions'
  ],
  openclaude: ['--permission-mode bypassPermissions', '--permission-mode=bypassPermissions'],
  codex: ['--yolo']
}

function optionTokens(value: string, shell: AgentStartupShell): StartupCommandTokens {
  const tokenized = tokenizeStartupCommand(value, shell)
  if (!tokenized.ok) {
    return tokenized
  }
  // Why: operands after `--` are prompt text, never options.
  const terminator = tokenized.tokens.indexOf('--')
  return terminator === -1
    ? tokenized
    : {
        ok: true,
        tokens: tokenized.tokens.slice(0, terminator),
        spans: tokenized.spans.slice(0, terminator)
      }
}

/** Index where `sequence` starts in `tokens`, or -1. */
function findTokenSequence(tokens: readonly string[], sequence: readonly string[]): number {
  return tokens.findIndex(
    (_, index) =>
      index + sequence.length <= tokens.length &&
      sequence.every((token, offset) => tokens[index + offset] === token)
  )
}

function tokenizeFlag(flag: string): string[] {
  const tokenized = tokenizeStartupCommand(flag, 'posix')
  return tokenized.ok ? tokenized.tokens : []
}

/** Every spelling that puts this agent in bypass, canonical first. */
const bypassTokenSequenceCache = new Map<TuiAgent, string[][]>()

function bypassTokenSequences(agent: TuiAgent): string[][] {
  let sequences = bypassTokenSequenceCache.get(agent)
  if (!sequences) {
    sequences = [YOLO_TUI_AGENT_ARGS[agent], ...(BYPASS_ARG_ALIASES[agent] ?? [])]
      .filter((flag): flag is string => flag !== undefined)
      .map(tokenizeFlag)
      .filter((tokens) => tokens.length > 0)
    bypassTokenSequenceCache.set(agent, sequences)
  }
  return sequences
}

// Why every grammar: one settings string reaches POSIX, PowerShell and cmd hosts, so text any of
// them would read as a permission option counts — adding a second flag beside it can stop the CLI.
const LAUNCH_GRAMMARS: readonly AgentStartupShell[] = ['posix', 'powershell', 'cmd']

function isPermissionOption(token: string, name: string): boolean {
  // Short options also take their value attached (`-anever`).
  const short = /^-[a-zA-Z]$/.test(name)
  return token === name || token.startsWith(`${name}=`) || (short && token.startsWith(name))
}

/** Permission-changing options in these arguments, under any launch grammar, in order. */
const optionNameCache = new Map<TuiAgent, readonly string[]>()

function argumentPermissionOptions(agent: TuiAgent, args: string): string[] {
  let names = optionNameCache.get(agent)
  if (!names) {
    names = agentPermissionOptionNames(agent)
    optionNameCache.set(agent, names)
  }
  if (!args.trim()) {
    return []
  }
  const found: string[] = []
  for (const shell of LAUNCH_GRAMMARS) {
    const tokens = optionTokens(args, shell)
    for (const token of tokens.ok ? tokens.tokens : []) {
      if (!found.includes(token) && names.some((name) => isPermissionOption(token, name))) {
        found.push(token)
      }
    }
  }
  return found
}

/** Whether these arguments set this agent's permissions themselves, so its mode adds nothing. */
export function tuiAgentArgsSetPermissions(
  agent: TuiAgent,
  args: string | null | undefined
): boolean {
  return argumentPermissionOptions(agent, args ?? '').length > 0
}

/**
 * Finds the flag under POSIX, else PowerShell grammar (Windows paths like `C:\dir\` mis-split
 * under POSIX); cmd only when neither parses, since cmd would read inside single quotes.
 */
function findBypassFlag(
  text: string,
  flag: readonly string[]
): { tokens: { tokens: string[]; spans: CommandTokenSpan[] }; at: number } | null {
  let parsed = false
  for (const shell of ['posix', 'powershell'] as const) {
    const tokens = optionTokens(text, shell)
    if (tokens.ok) {
      parsed = true
      const at = findTokenSequence(tokens.tokens, flag)
      if (at !== -1) {
        return { tokens, at }
      }
    }
  }
  const cmd = parsed ? null : optionTokens(text, 'cmd')
  const at = cmd?.ok ? findTokenSequence(cmd.tokens, flag) : -1
  return cmd?.ok && at !== -1 ? { tokens: cmd, at } : null
}

/**
 * Splits the bypass flag out of arguments saved before the mode was typed, keeping the rest's quoting.
 * Text that still sets permissions keeps the flag: a launch adds none beside it, so lifting would drop it.
 */
export function liftTuiAgentBypassArgs(
  agent: TuiAgent,
  args: string | null | undefined
): { bypass: boolean; extraArgs: string } {
  const original = args?.trim() ?? ''
  const flag = YOLO_TUI_AGENT_ARGS[agent] ? (bypassTokenSequences(agent)[0] ?? []) : []
  let text = original
  let bypass = false
  while (flag.length > 0 && text) {
    const found = findBypassFlag(text, flag)
    if (!found) {
      break
    }
    const { tokens, at } = found
    bypass = true
    const before = text.slice(0, tokens.spans[at].start).trimEnd()
    const after = text.slice(tokens.spans[at + flag.length - 1].end).trimStart()
    text = before && after ? `${before} ${after}` : before || after
  }
  if (bypass && tuiAgentArgsSetPermissions(agent, text)) {
    return { bypass, extraArgs: original }
  }
  return { bypass, extraArgs: text }
}

/** Splits this agent's env-driven permission bypass out of an environment record. */
export function liftTuiAgentBypassEnv(
  agent: TuiAgent,
  env: Record<string, string> | null | undefined
): { bypass: boolean; extraEnv: Record<string, string> } {
  const extraEnv = { ...env }
  const bypassEnv = YOLO_TUI_AGENT_ENV[agent]
  if (!bypassEnv || !Object.entries(bypassEnv).every(([name, value]) => extraEnv[name] === value)) {
    return { bypass: false, extraEnv }
  }
  for (const name of Object.keys(bypassEnv)) {
    delete extraEnv[name]
  }
  return { bypass: true, extraEnv }
}

export type AgentPermissionPosture = {
  /** The mode Settings stores for this agent. */
  mode: AgentPermissionMode
  /** Whether the agent actually launches in bypass, after its own Arguments and env have their say. */
  effectiveBypass: boolean
  /** Permission settings typed into the agent's Arguments or env; when present they decide. */
  typedPermissionOptions: string[]
}

/** What an agent's permission settings add up to; Settings and structured sessions both read it. */
export function resolveAgentPermissionPosture(
  agent: TuiAgent,
  settings:
    | (AgentLaunchProfileSettings & Partial<Pick<GlobalSettings, 'terminalWindowsShell'>>)
    | null
    | undefined,
  platform: NodeJS.Platform
): AgentPermissionPosture {
  const mode = resolveAgentPermissionMode(agent, settings)
  const extra = settings?.agentDefaultArgs?.[agent] ?? ''
  const env = settings?.agentDefaultEnv?.[agent] ?? {}
  const argOptions = argumentPermissionOptions(agent, extra)
  // Extra env overrides the mode's env (see resolveTuiAgentLaunchEnv), so a typed key decides.
  const envOptions = Object.keys(YOLO_TUI_AGENT_ENV[agent] ?? {})
    .filter((name) => Object.hasOwn(env, name))
    .map((name) => `${name}=${env[name]}`)
  const typedPermissionOptions = [...argOptions, ...envOptions]
  if (typedPermissionOptions.length === 0) {
    return {
      mode,
      effectiveBypass: mode === 'bypass' && agentHasPermissionMode(agent),
      typedPermissionOptions
    }
  }
  // Why the local launch shell: quoted text or operands after `--` must not authorize a session.
  const shell = resolveStartupShell(
    platform,
    resolveLocalWindowsAgentStartupShell({
      platform,
      isRemote: false,
      terminalWindowsShell: settings?.terminalWindowsShell
    })
  )
  const tokens = optionTokens(extra, shell)
  const argsBypass =
    tokens.ok &&
    bypassTokenSequences(agent).some(
      (sequence) => findTokenSequence(tokens.tokens, sequence) !== -1
    )
  const envBypass = envOptions.length > 0 && liftTuiAgentBypassEnv(agent, env).bypass
  return { mode, effectiveBypass: argsBypass || envBypass, typedPermissionOptions }
}
