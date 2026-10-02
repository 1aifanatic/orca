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
  type AgentStartupShell
} from './tui-agent-startup-shell'
import type { TuiAgent } from './tui-agent'
import { resolveLocalWindowsAgentStartupShell } from './windows-terminal-shell'

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

function optionTokensBeforeTerminator(value: string, shell: AgentStartupShell): string[] {
  const tokenized = tokenizeStartupCommand(value, shell)
  if (!tokenized.ok) {
    return []
  }
  const terminator = tokenized.tokens.indexOf('--')
  return terminator === -1 ? tokenized.tokens : tokenized.tokens.slice(0, terminator)
}

/**
 * Splits this agent's permission-bypass flag out of an arguments string.
 *
 * Matches the flag's whole token sequence as options (outside quotes, before `--`) and cuts
 * those exact characters out, so the rest of the user's text keeps its own quoting. Used to
 * read arguments written before the mode was typed, which stored the flag inline.
 */
export function liftTuiAgentBypassArgs(
  agent: TuiAgent,
  args: string | null | undefined
): { bypass: boolean; extraArgs: string } {
  let text = args?.trim() ?? ''
  const bypassArg = YOLO_TUI_AGENT_ARGS[agent]
  const flag = bypassArg ? tokenizeStartupCommand(bypassArg, 'posix') : null
  if (!flag?.ok || !text) {
    return { bypass: false, extraArgs: text }
  }
  let bypass = false
  for (;;) {
    const tokenized = tokenizeStartupCommand(text, 'posix')
    if (!tokenized.ok) {
      return { bypass, extraArgs: text }
    }
    const terminator = tokenized.tokens.indexOf('--')
    const limit = terminator === -1 ? tokenized.tokens.length : terminator
    const width = flag.tokens.length
    let at = -1
    for (let index = 0; index + width <= limit; index += 1) {
      if (flag.tokens.every((token, offset) => tokenized.tokens[index + offset] === token)) {
        at = index
        break
      }
    }
    if (at === -1) {
      return { bypass, extraArgs: text }
    }
    bypass = true
    const before = text.slice(0, tokenized.spans[at].start).trimEnd()
    const after = text.slice(tokenized.spans[at + width - 1].end).trimStart()
    text = before && after ? `${before} ${after}` : before || after
  }
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

function containsTokenSequence(tokens: readonly string[], sequence: readonly string[]): boolean {
  return tokens.some(
    (_, index) =>
      index + sequence.length <= tokens.length &&
      sequence.every((token, offset) => tokens[index + offset] === token)
  )
}

/** Permission-changing options in these arguments, and whether they include the bypass flag. */
function readArgumentPermissionOptions(
  agent: TuiAgent,
  args: string,
  shell: AgentStartupShell
): { options: string[]; bypass: boolean } {
  // Why the launch shell's grammar: quoted prompt text and operands after `--` must not count.
  const tokens = optionTokensBeforeTerminator(args, shell)
  const names = agentPermissionOptionNames(agent)
  const bypassArg = YOLO_TUI_AGENT_ARGS[agent]
  const flag = bypassArg ? tokenizeStartupCommand(bypassArg, 'posix') : null
  return {
    options: tokens.filter((token) =>
      names.some((name) => token === name || token.startsWith(`${name}=`))
    ),
    bypass: flag?.ok === true && containsTokenSequence(tokens, flag.tokens)
  }
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
    readArgumentPermissionOptions(agent, extra, 'posix').options.length > 0
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
  const shell = resolveStartupShell(
    platform,
    resolveLocalWindowsAgentStartupShell({
      platform,
      isRemote: false,
      terminalWindowsShell: settings?.terminalWindowsShell
    })
  )
  const mode = resolveAgentPermissionMode(agent, settings)
  const typed = readArgumentPermissionOptions(
    agent,
    settings?.agentDefaultArgs?.[agent] ?? '',
    shell
  )
  return {
    mode,
    effectiveBypass:
      typed.options.length > 0 ? typed.bypass : mode === 'bypass' && agentHasPermissionMode(agent),
    argumentPermissionOptions: typed.options
  }
}
