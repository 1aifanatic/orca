import type { Automation } from './automations-types'
import {
  EXTRA_AGENT_ARGS_REQUIRE_FRESH_SESSION,
  hasExtraAgentArgs,
  parseExtraAgentArgs
} from './automation-extra-agent-args'
import { resolveStartupShell, type AgentStartupShell } from './tui-agent-startup-shell'
import { resolveLocalWindowsAgentStartupShell } from './windows-terminal-shell'

/** Stored form of an extras input: the text unchanged, or `undefined` when it holds no extras. */
export function storedExtraAgentArgs(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined
  }
  if (typeof value !== 'string') {
    throw new Error('Extra agent arguments must be text.')
  }
  return hasExtraAgentArgs(value) ? value : undefined
}

/** The shell save-time validation assumes; launch re-validates against the PTY's real shell. */
export function automationSaveStartupShell(args: {
  platform: NodeJS.Platform
  executionTargetType: Automation['executionTargetType']
  terminalWindowsShell?: string | null
}): AgentStartupShell {
  if (args.executionTargetType === 'ssh') {
    return 'posix'
  }
  return resolveStartupShell(
    args.platform,
    resolveLocalWindowsAgentStartupShell({
      platform: args.platform,
      isRemote: false,
      terminalWindowsShell: args.terminalWindowsShell
    })
  )
}

/** Validates a whole record, so a patch that only enables Reuse still sees stored extras. */
export function assertAutomationExtraAgentArgs(
  automation: Pick<Automation, 'agentId' | 'extraAgentArgs' | 'reuseSession'>,
  shell: AgentStartupShell
): void {
  if (!hasExtraAgentArgs(automation.extraAgentArgs)) {
    return
  }
  if (automation.reuseSession) {
    throw new Error(EXTRA_AGENT_ARGS_REQUIRE_FRESH_SESSION)
  }
  const parsed = parseExtraAgentArgs({
    agent: automation.agentId,
    extraAgentArgs: automation.extraAgentArgs,
    shell
  })
  if (!parsed.ok) {
    throw new Error(parsed.error)
  }
}
