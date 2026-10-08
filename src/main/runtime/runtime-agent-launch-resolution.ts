import { createHash } from 'node:crypto'
import type { Repo } from '../../shared/repo-types'
import type { TuiAgent } from '../../shared/tui-agent'
import type { SleepingAgentLaunchConfig } from '../../shared/agent-session-resume'
import type { ClaudeAgentTeamsMode } from '../../shared/claude-agent-teams-tmux-compat'
import type { ProjectExecutionRuntimeResolution } from '../../shared/project-execution-runtime'
import type { TerminalCreateOptions } from './runtime-terminal-contracts'
import type { RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'
import { isWindowsAbsolutePathLike } from '../../shared/cross-platform-path'
import {
  getTuiAgentLaunchCommand,
  isTuiAgent,
  TUI_AGENT_CONFIG
} from '../../shared/tui-agent-config'
import { isTuiAgentEnabled } from '../../shared/tui-agent-selection'
import {
  normalizeProcessName,
  recognizeAgentProcessFromCommandLine
} from '../../shared/agent-process-recognition'
import { tokenizeCommandLine } from '../../shared/agent-command-line-entrypoint'
import { extractLeadingEnvAssignments } from '../../shared/command-environment'

export function mergeTerminalEnvDeletionKeys(
  first: readonly string[] | undefined,
  second: readonly string[] | undefined
): string[] | undefined {
  const merged = [...new Set([...(first ?? []), ...(second ?? [])])]
  return merged.length > 0 ? merged : undefined
}

export function isAgentSessionOperationOutcomeUnknown(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'agentSessionOperationOutcome' in error &&
    error.agentSessionOperationOutcome === 'unknown'
  )
}

export function deterministicAgentSessionUuid(seed: string): string {
  const hex = createHash('sha256').update(seed).digest('hex').slice(0, 32).split('')
  hex[12] = '4'
  hex[16] = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16)
  const value = hex.join('')
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`
}

export function copySleepingAgentLaunchConfig(
  config: SleepingAgentLaunchConfig
): SleepingAgentLaunchConfig {
  return {
    ...(config.agentCommand ? { agentCommand: config.agentCommand } : {}),
    agentArgs: config.agentArgs,
    agentEnv: { ...config.agentEnv },
    ...(config.ompResumeFilePath ? { ompResumeFilePath: config.ompResumeFilePath } : {})
  }
}

export function normalizeAgentLaunchCommandForMatch(command: string): string {
  return command.trim().replace(/\s+/g, ' ')
}

export function resolveBareAgentLaunchCommand(args: {
  command: string | undefined
  settings: {
    agentCmdOverrides?: Partial<Record<TuiAgent, string>> | null
    disabledTuiAgents?: Iterable<unknown> | null
  }
  platform: NodeJS.Platform
  isRemote: boolean
}): TuiAgent | null {
  const command = args.command ? normalizeAgentLaunchCommandForMatch(args.command) : ''
  if (!command) {
    return null
  }

  const cmdOverrides = args.settings.agentCmdOverrides ?? {}
  for (const agent of Object.keys(TUI_AGENT_CONFIG) as TuiAgent[]) {
    if (!isTuiAgentEnabled(agent, args.settings.disabledTuiAgents)) {
      continue
    }
    const override = cmdOverrides[agent]?.trim()
    const defaultLaunchCommand = getTuiAgentLaunchCommand(TUI_AGENT_CONFIG[agent], args.platform, {
      isRemote: args.isRemote
    })
    const launchCommands = override ? [defaultLaunchCommand, override] : [defaultLaunchCommand]
    if (
      launchCommands.some((candidate) => command === normalizeAgentLaunchCommandForMatch(candidate))
    ) {
      return agent
    }
  }

  return null
}

type AgentLaunchCommandResolutionArgs = Parameters<typeof resolveBareAgentLaunchCommand>[0]

function launchArgv(command: string): string[] {
  return extractLeadingEnvAssignments(tokenizeCommandLine(command)).rest
}

/** An override's command words, without its flags: `npx pkg --x` must not claim every `npx`. */
function overrideMatchesArgv(override: string, argv: readonly string[]): boolean {
  const words = launchArgv(override)
  const flagAt = words.findIndex((word) => word.startsWith('-'))
  const commandWords = flagAt === -1 ? words : words.slice(0, flagAt)
  return (
    commandWords.length > 0 &&
    normalizeProcessName(commandWords[0]) === normalizeProcessName(argv[0]) &&
    commandWords.every((word, index) => index === 0 || word === argv[index])
  )
}

/**
 * The agent a launch command runs, read from its argv rather than the whole line, so
 * `omp --thinking high` still names OMP. Identity only: unlike resolveBareAgentLaunchCommand,
 * a match here must not let Orca rebuild the user's command.
 */
export function resolveAgentLaunchCommandIdentity(
  args: AgentLaunchCommandResolutionArgs
): TuiAgent | null {
  const exact = resolveBareAgentLaunchCommand(args)
  if (exact || !args.command) {
    return exact
  }
  const argv = launchArgv(args.command)
  if (argv.length === 0) {
    return null
  }
  const enabled = (agent: TuiAgent): boolean =>
    isTuiAgentEnabled(agent, args.settings.disabledTuiAgents)
  for (const [agent, override] of Object.entries(args.settings.agentCmdOverrides ?? {})) {
    if (isTuiAgent(agent) && enabled(agent) && override && overrideMatchesArgv(override, argv)) {
      return agent
    }
  }
  // Why requote: the recognizer re-tokenizes, and a quoted Windows path may hold spaces.
  const recognized = recognizeAgentProcessFromCommandLine(
    argv.map((word) => (/\s/.test(word) ? `"${word}"` : word)).join(' ')
  )?.agent
  return isTuiAgent(recognized) && enabled(recognized) ? recognized : null
}

export function recordPtyLaunchAgents(
  pty: Pick<RuntimePtyWorktreeRecord, 'launchAgent' | 'launchCommandIdentity'>,
  launch: Pick<TerminalCreateOptions, 'launchAgent' | 'launchCommandIdentity'>
): void {
  pty.launchAgent = launch.launchAgent ?? null
  pty.launchCommandIdentity = launch.launchCommandIdentity
}

export function inferCapturedClaudeAgentTeamsMode(
  launchConfig: SleepingAgentLaunchConfig | undefined,
  command: string | undefined,
  currentMode: ClaudeAgentTeamsMode | undefined
): ClaudeAgentTeamsMode | undefined {
  const capturedCommand = launchConfig?.agentCommand?.trim() || command?.trim() || ''
  const capturedArgs = launchConfig?.agentArgs?.trim() ?? ''
  const capturedLaunch = `${capturedCommand} ${capturedArgs}`.trim()
  if (/(^|\s)--teammate-mode(?:=|\s+)auto(?:\s|$)/.test(capturedLaunch)) {
    return 'native-panes-shim'
  }
  if (/(^|\s)--teammate-mode(?:=|\s+)in-process(?:\s|$)/.test(capturedLaunch)) {
    return 'in-process'
  }
  if (launchConfig && /(^|\s)--resume(?:\s|=|$)/.test(command?.trim() ?? '')) {
    return 'off'
  }
  return currentMode
}

export function getAgentLaunchPlatformForRepo(
  repo: Pick<Repo, 'connectionId' | 'path'>,
  projectRuntime?: ProjectExecutionRuntimeResolution
): NodeJS.Platform {
  if (!repo.connectionId) {
    if (projectRuntime?.status === 'repair-required') {
      return projectRuntime.repair.preferredRuntime.kind === 'wsl' ? 'linux' : process.platform
    }
    if (projectRuntime?.status === 'resolved' && projectRuntime.runtime.kind === 'wsl') {
      return 'linux'
    }
    return process.platform
  }
  return isWindowsAbsolutePathLike(repo.path) ? 'win32' : 'linux'
}
