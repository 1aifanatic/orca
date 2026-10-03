import type { GlobalSettings } from './global-settings-types'
import {
  AGENT_PERMISSION_ARG_SPECS,
  agentHasPermissionMode,
  resolveAgentPermissionMode,
  YOLO_TUI_AGENT_ARGS,
  YOLO_TUI_AGENT_ENV,
  type AgentPermissionArgSpec,
  type AgentPermissionMode,
  type AgentPermissionOption
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

/** Tokens of free-text arguments under one grammar, up to any `--`. */
export function optionTokens(value: string, shell: AgentStartupShell): StartupCommandTokens {
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

/** A quoted word is a value the user wrote literally, never an option. */
export function isQuotedToken(text: string, span: CommandTokenSpan): boolean {
  return text[span.start] === '"' || text[span.start] === "'"
}

function tokenizeFlag(flag: string | undefined): string[] {
  const tokenized = flag ? tokenizeStartupCommand(flag, 'posix') : null
  return tokenized?.ok ? tokenized.tokens : []
}

const bypassFlagCache = new Map<TuiAgent, string[]>()

/** The agent's bypass flag as tokens; empty for an agent with none. */
export function bypassFlagTokens(agent: TuiAgent): string[] {
  let tokens = bypassFlagCache.get(agent)
  if (!tokens) {
    tokens = tokenizeFlag(YOLO_TUI_AGENT_ARGS[agent])
    bypassFlagCache.set(agent, tokens)
  }
  return tokens
}

/** The permission options an agent's bypass flag sets, for agents with no wider table entry. */
function specFromBypassFlag(flag: readonly string[]): AgentPermissionArgSpec {
  const options: AgentPermissionOption[] = []
  const bypass: Record<string, string | true> = {}
  for (let index = 0; index < flag.length; index += 1) {
    const value = flag[index + 1]
    const takesValue = value !== undefined && !value.startsWith('-')
    options.push({ names: [flag[index]], takesValue })
    bypass[flag[index]] = takesValue ? value : true
    if (takesValue) {
      index += 1
    }
  }
  return { options, bypass: options.length > 0 ? [bypass] : [] }
}

const argSpecCache = new Map<TuiAgent, AgentPermissionArgSpec>()

function agentPermissionArgSpec(agent: TuiAgent): AgentPermissionArgSpec {
  let spec = argSpecCache.get(agent)
  if (!spec) {
    spec = AGENT_PERMISSION_ARG_SPECS[agent] ?? specFromBypassFlag(bypassFlagTokens(agent))
    argSpecCache.set(agent, spec)
  }
  return spec
}

/** The value this token gives `option`, `{}` when the value is the next token, or null if it is another word. */
function readOptionToken(
  option: AgentPermissionOption,
  token: string
): { value?: string | true } | null {
  for (const name of option.names) {
    if (token === name) {
      return option.takesValue ? {} : { value: true }
    }
    if (token.startsWith(`${name}=`)) {
      return { value: token.slice(name.length + 1) }
    }
    // Short options also take their value attached (`-anever`).
    if (/^-[a-zA-Z]$/.test(name) && token.startsWith(name)) {
      return { value: token.slice(name.length) }
    }
  }
  return null
}

type TypedPermissionSetting = { option: string; value: string | true; text: string }

function readTypedSettings(
  spec: AgentPermissionArgSpec,
  text: string,
  tokens: { tokens: string[]; spans: CommandTokenSpan[] }
): TypedPermissionSetting[] {
  const settings: TypedPermissionSetting[] = []
  for (let index = 0; index < tokens.tokens.length; index += 1) {
    if (isQuotedToken(text, tokens.spans[index])) {
      continue
    }
    const token = tokens.tokens[index]
    for (const option of spec.options) {
      const read = readOptionToken(option, token)
      if (!read) {
        continue
      }
      const next = read.value === undefined ? tokens.tokens[index + 1] : undefined
      settings.push({
        option: option.names[0],
        value: read.value ?? next ?? '',
        text: next === undefined ? token : `${token} ${next}`
      })
      if (next !== undefined) {
        index += 1
      }
      break
    }
  }
  return settings
}

export type TypedAgentPermissionKind = 'none' | 'bypass' | 'other'

function readKind(
  spec: AgentPermissionArgSpec,
  settings: readonly TypedPermissionSetting[]
): TypedAgentPermissionKind {
  if (settings.length === 0) {
    return 'none'
  }
  const typedBypasses = spec.bypass.filter((bypass) =>
    Object.entries(bypass).every(([option, value]) =>
      settings.some((setting) => setting.option === option && setting.value === value)
    )
  )
  // Bypass only when every typed setting belongs to a bypass typed in full (`-a never` alone asks).
  return typedBypasses.length > 0 &&
    settings.every((setting) =>
      typedBypasses.some((bypass) => bypass[setting.option] === setting.value)
    )
    ? 'bypass'
    : 'other'
}

// Why every grammar: one settings string reaches POSIX, PowerShell and cmd hosts, so text any of
// them would read as a permission option counts — adding a second flag beside it can stop the CLI.
const LAUNCH_GRAMMARS: readonly AgentStartupShell[] = ['posix', 'powershell', 'cmd']

export type TypedAgentPermissions = {
  kind: TypedAgentPermissionKind
  /** The typed settings as written, in order, for Settings to name. */
  options: string[]
}

function classifyArgs(
  agent: TuiAgent,
  args: string,
  shell: AgentStartupShell | undefined
): TypedAgentPermissions {
  const spec = agentPermissionArgSpec(agent)
  const options: string[] = []
  const kinds = new Map<AgentStartupShell, TypedAgentPermissionKind>()
  for (const grammar of args.trim() && spec.options.length > 0 ? LAUNCH_GRAMMARS : []) {
    const tokens = optionTokens(args, grammar)
    if (!tokens.ok) {
      continue
    }
    const settings = readTypedSettings(spec, args, tokens)
    kinds.set(grammar, readKind(spec, settings))
    options.push(
      ...settings.map((setting) => setting.text).filter((text) => !options.includes(text))
    )
  }
  if (options.length === 0) {
    return { kind: 'none', options }
  }
  // Read as the launch shell parses it; without one, every grammar that sees a setting must agree.
  const verdicts = shell
    ? [kinds.get(shell) ?? 'none']
    : [...kinds.values()].filter((kind) => kind !== 'none')
  return {
    kind: verdicts.length > 0 && verdicts.every((kind) => kind === 'bypass') ? 'bypass' : 'other',
    options
  }
}

function classifyEnv(agent: TuiAgent, env: Record<string, string>): TypedAgentPermissions {
  // Extra env overrides the mode's env (see resolveTuiAgentLaunchEnv), so a typed key decides.
  const typed = Object.keys(YOLO_TUI_AGENT_ENV[agent] ?? {}).filter((name) =>
    Object.hasOwn(env, name)
  )
  if (typed.length === 0) {
    return { kind: 'none', options: [] }
  }
  return {
    kind: Object.entries(YOLO_TUI_AGENT_ENV[agent] ?? {}).every(
      ([name, value]) => env[name] === value
    )
      ? 'bypass'
      : 'other',
    options: typed.map((name) => `${name}=${env[name]}`)
  }
}

/**
 * What permission settings typed into an agent's Arguments and env do: nothing (its mode decides),
 * bypass, or something else. Launch, Settings, structured sessions and the migration all read this.
 */
export function classifyTypedAgentPermissions(
  agent: TuiAgent,
  typed: { args?: string | null; env?: Record<string, string> | null },
  shell?: AgentStartupShell
): TypedAgentPermissions {
  const args = classifyArgs(agent, typed.args ?? '', shell)
  const env = classifyEnv(agent, typed.env ?? {})
  const kinds = [args.kind, env.kind].filter((kind) => kind !== 'none')
  return {
    kind:
      kinds.length === 0 ? 'none' : kinds.every((kind) => kind === 'bypass') ? 'bypass' : 'other',
    options: [...args.options, ...env.options]
  }
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
  // Why the local launch shell: quoted text or operands after `--` must not authorize a session.
  const shell = resolveStartupShell(
    platform,
    resolveLocalWindowsAgentStartupShell({
      platform,
      isRemote: false,
      terminalWindowsShell: settings?.terminalWindowsShell
    })
  )
  const typed = classifyTypedAgentPermissions(
    agent,
    { args: settings?.agentDefaultArgs?.[agent], env: settings?.agentDefaultEnv?.[agent] },
    shell
  )
  return {
    mode,
    effectiveBypass:
      typed.kind === 'none'
        ? mode === 'bypass' && agentHasPermissionMode(agent)
        : typed.kind === 'bypass',
    typedPermissionOptions: typed.options
  }
}
