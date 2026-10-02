import type { GlobalSettings } from './global-settings-types'
import { isTuiAgent, TUI_AGENT_CONFIG } from './tui-agent-config'
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
import type { TuiAgent } from './tui-agent'
import { resolveLocalWindowsAgentStartupShell } from './windows-terminal-shell'

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

const UNSUPPORTED_TUI_AGENT_ARGS: Partial<Record<TuiAgent, readonly string[]>> = {
  opencode: ['--dangerously-skip-permissions'],
  kilo: ['--dangerously-skip-permissions']
}

/** The settings slice that decides an agent's launch arguments and environment. */
export type AgentLaunchProfileSettings = Partial<
  Pick<
    GlobalSettings,
    'agentDefaultArgs' | 'agentDefaultEnv' | 'agentPermissionMode' | 'agentPermissionModeOverrides'
  >
>

function argPattern(arg: string): RegExp {
  return new RegExp(`(^|\\s)${arg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=\\s|$)`, 'g')
}

export function hasUnsupportedTuiAgentArgs(agent: TuiAgent, value: unknown): boolean {
  if (typeof value !== 'string') {
    return false
  }
  return (UNSUPPORTED_TUI_AGENT_ARGS[agent] ?? []).some((arg) => argPattern(arg).test(value))
}

function sanitizeTuiAgentLaunchArgs(agent: TuiAgent, args: string): string {
  const unsupportedArgs = UNSUPPORTED_TUI_AGENT_ARGS[agent]
  if (!unsupportedArgs) {
    return args.trim()
  }
  // Why: a few agents have removed, relocated, or never exposed Claude-style
  // skip-permission flags on the interactive TUI command Orca launches.
  return unsupportedArgs.reduce((next, arg) => next.replace(argPattern(arg), ' '), args).trim()
}

export function normalizeTuiAgentArgsRecord(value: unknown): Partial<Record<TuiAgent, string>> {
  const normalized: Partial<Record<TuiAgent, string>> = {}
  if (!value || typeof value !== 'object') {
    return normalized
  }
  for (const [agent, args] of Object.entries(value)) {
    if (!isTuiAgent(agent) || typeof args !== 'string') {
      continue
    }
    normalized[agent] = sanitizeTuiAgentLaunchArgs(agent, args)
  }
  return normalized
}

export function normalizeTuiAgentEnvRecord(
  value: unknown
): Partial<Record<TuiAgent, Record<string, string>>> {
  const normalized: Partial<Record<TuiAgent, Record<string, string>>> = {}
  if (!value || typeof value !== 'object') {
    return normalized
  }
  for (const [agent, env] of Object.entries(value)) {
    if (!isTuiAgent(agent) || !env || typeof env !== 'object') {
      continue
    }
    const nextEnv: Record<string, string> = {}
    for (const [name, raw] of Object.entries(env)) {
      const key = name.trim()
      if (!key || typeof raw !== 'string') {
        continue
      }
      nextEnv[key] = raw
    }
    normalized[agent] = nextEnv
  }
  return normalized
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
function bypassTokenSequences(agent: TuiAgent): string[][] {
  return [YOLO_TUI_AGENT_ARGS[agent], ...(BYPASS_ARG_ALIASES[agent] ?? [])]
    .filter((flag): flag is string => flag !== undefined)
    .map(tokenizeFlag)
    .filter((tokens) => tokens.length > 0)
}

// Why every grammar: one settings string reaches POSIX, PowerShell and cmd hosts, so text any of
// them would read as a permission option counts — adding a second flag beside it can stop the CLI.
const LAUNCH_GRAMMARS: readonly AgentStartupShell[] = ['posix', 'powershell', 'cmd']

/** Permission-changing options in these arguments, under any launch grammar, in order. */
function argumentPermissionOptions(agent: TuiAgent, args: string): string[] {
  const names = agentPermissionOptionNames(agent)
  const found: string[] = []
  for (const shell of LAUNCH_GRAMMARS) {
    const tokens = optionTokens(args, shell)
    for (const token of tokens.ok ? tokens.tokens : []) {
      if (
        !found.includes(token) &&
        names.some((name) => token === name || token.startsWith(`${name}=`))
      ) {
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
 * Splits this agent's permission-bypass flag out of an arguments string.
 *
 * Matches the flag's whole token sequence as options (outside quotes, before `--`) and cuts
 * those exact characters out, so the rest of the user's text keeps its own quoting. Used to
 * read arguments written before the mode was typed, which stored the flag inline. When the rest
 * still sets permissions itself, the text is kept whole: a launch adds no flag beside such text,
 * so lifting it out would drop it.
 */
export function liftTuiAgentBypassArgs(
  agent: TuiAgent,
  args: string | null | undefined
): { bypass: boolean; extraArgs: string } {
  const original = args?.trim() ?? ''
  const bypassArg = YOLO_TUI_AGENT_ARGS[agent]
  const flag = bypassArg ? tokenizeFlag(bypassArg) : []
  let text = original
  let bypass = false
  while (flag.length > 0 && text) {
    const tokens = optionTokens(text, 'posix')
    const at = tokens.ok ? findTokenSequence(tokens.tokens, flag) : -1
    if (!tokens.ok || at === -1) {
      break
    }
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

/**
 * The launch arguments for this agent: its permission mode's flag, then the user's extra text.
 *
 * This is the one place a permission mode becomes a CLI flag. `extraArgs` replaces the configured
 * extra text for one launch (e.g. a Source Control action's own arguments); the mode still applies.
 * When the extra text already sets permissions itself — the bypass flag, or an option like
 * `--permission-mode` / `-a` — that text decides and no flag is added: a repeated or conflicting
 * flag makes clap-based CLIs refuse to start.
 */
export function resolveTuiAgentLaunchArgs(
  agent: TuiAgent,
  settings: AgentLaunchProfileSettings | null | undefined,
  extraArgs?: string | null
): string {
  // `undefined` means the configured text; `null` means none for this launch.
  const extra = (
    extraArgs === undefined ? (settings?.agentDefaultArgs?.[agent] ?? '') : (extraArgs ?? '')
  ).trim()
  const bypassArg = YOLO_TUI_AGENT_ARGS[agent]
  if (
    !bypassArg ||
    resolveAgentPermissionMode(agent, settings) !== 'bypass' ||
    tuiAgentArgsSetPermissions(agent, extra)
  ) {
    return extra
  }
  return extra ? `${bypassArg} ${extra}` : bypassArg
}

/** The launch environment for this agent: its permission mode's env, then the user's extra env. */
export function resolveTuiAgentLaunchEnv(
  agent: TuiAgent,
  settings: AgentLaunchProfileSettings | null | undefined
): Record<string, string> {
  const extra = settings?.agentDefaultEnv?.[agent] ?? {}
  const bypassEnv = YOLO_TUI_AGENT_ENV[agent]
  return bypassEnv && resolveAgentPermissionMode(agent, settings) === 'bypass'
    ? { ...bypassEnv, ...extra }
    : { ...extra }
}

/**
 * Every agent's launch-ready arguments, flag included: the shape paired clients read from
 * `settings.get` and wrote before the mode was typed. Derived per read, never stored.
 */
export function composeTuiAgentLaunchArgsRecord(
  settings: AgentLaunchProfileSettings | null | undefined
): Partial<Record<TuiAgent, string>> {
  const record: Partial<Record<TuiAgent, string>> = {}
  for (const agent of Object.keys(TUI_AGENT_CONFIG)) {
    if (isTuiAgent(agent)) {
      record[agent] = resolveTuiAgentLaunchArgs(agent, settings)
    }
  }
  return record
}

/** Every agent's launch-ready environment; see composeTuiAgentLaunchArgsRecord. */
export function composeTuiAgentLaunchEnvRecord(
  settings: AgentLaunchProfileSettings | null | undefined
): Partial<Record<TuiAgent, Record<string, string>>> {
  const record: Partial<Record<TuiAgent, Record<string, string>>> = {}
  for (const agent of Object.keys(TUI_AGENT_CONFIG)) {
    if (isTuiAgent(agent)) {
      record[agent] = resolveTuiAgentLaunchEnv(agent, settings)
    }
  }
  return record
}

/**
 * Reads one agent's arguments out of a launch-ready record (flag already inside) — what a host
 * publishes to paired clients, and what profiles stored before the mode was typed. A missing key
 * falls back to the bypass flag, which is what those records meant by it. Never for stored
 * settings: use resolveTuiAgentLaunchArgs.
 */
export function resolveComposedTuiAgentLaunchArgs(
  agent: TuiAgent,
  record: Partial<Record<TuiAgent, string>> | null | undefined
): string {
  if (record && Object.hasOwn(record, agent) && typeof record[agent] === 'string') {
    return record[agent] ?? ''
  }
  return YOLO_TUI_AGENT_ARGS[agent] ?? ''
}

/** Environment counterpart of resolveComposedTuiAgentLaunchArgs. */
export function resolveComposedTuiAgentLaunchEnv(
  agent: TuiAgent,
  record: Partial<Record<TuiAgent, Record<string, string>>> | null | undefined
): Record<string, string> {
  if (record && Object.hasOwn(record, agent)) {
    return { ...record[agent] }
  }
  return { ...YOLO_TUI_AGENT_ENV[agent] }
}

export type AgentPermissionPosture = {
  /** The mode Settings stores for this agent. */
  mode: AgentPermissionMode
  /** Whether the agent actually launches in bypass, after its typed Arguments have their say. */
  effectiveBypass: boolean
  /** Permission-changing options typed into the agent's Arguments; when present they decide. */
  argumentPermissionOptions: string[]
}

/**
 * What an agent's permission settings add up to. Read by Settings and by structured sessions, so
 * both agree with what a terminal launch does (see resolveTuiAgentLaunchArgs).
 */
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
  const options = argumentPermissionOptions(agent, extra)
  if (options.length === 0) {
    return {
      mode,
      effectiveBypass: mode === 'bypass' && agentHasPermissionMode(agent),
      argumentPermissionOptions: options
    }
  }
  // Why the local launch shell here: this decides whether the CLI really bypasses, and quoted
  // text or operands after `--` must not authorize a structured session.
  const shell = resolveStartupShell(
    platform,
    resolveLocalWindowsAgentStartupShell({
      platform,
      isRemote: false,
      terminalWindowsShell: settings?.terminalWindowsShell
    })
  )
  const tokens = optionTokens(extra, shell)
  return {
    mode,
    effectiveBypass:
      tokens.ok &&
      bypassTokenSequences(agent).some(
        (sequence) => findTokenSequence(tokens.tokens, sequence) !== -1
      ),
    argumentPermissionOptions: options
  }
}
