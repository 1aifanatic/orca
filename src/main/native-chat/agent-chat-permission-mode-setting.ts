import type { GlobalSettings } from '../../shared/global-settings-types'
import type { AgentLaunchProfileSettings } from '../../shared/tui-agent-launch-defaults'
import type { AgentPermissionMode } from '../../shared/tui-agent-permissions'
import { resolveAgentPermissionPosture } from '../../shared/tui-agent-permission-args'
import { resolveLocalAgentLaunchTarget } from '../../shared/windows-terminal-shell'
import type { TuiAgent } from '../../shared/tui-agent'

export type AgentChatPermissionSettings =
  | (AgentLaunchProfileSettings & Partial<Pick<GlobalSettings, 'terminalWindowsShell'>>)
  | null
  | undefined

/**
 * Where a structured chat that never chose its own mode starts: the Agent Permissions setting
 * for this agent, read the way its Settings card shows it — the agent's typed mode, plus a bypass
 * flag typed into Arguments, which a terminal launch also honours.
 *
 * Read on every use rather than latched: the setting is the one copy of this fact. A chat's own
 * stored choice outranks it wherever the chat's record is in reach.
 */
export function agentChatPermissionModeForSettings(
  agent: TuiAgent,
  settings: AgentChatPermissionSettings
): AgentPermissionMode {
  const posture = resolveAgentPermissionPosture(
    agent,
    settings,
    resolveLocalAgentLaunchTarget(process.platform, settings?.terminalWindowsShell)
  )
  return posture.effectiveMode
}
