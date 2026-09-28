import type { GlobalSettings } from '../../shared/global-settings-types'
import type { TuiAgent } from '../../shared/tui-agent'
import { isTuiAgentEnabled } from '../../shared/tui-agent-selection'

export type AgentStatusHooksSettings =
  | Partial<Pick<GlobalSettings, 'agentStatusHooksEnabled' | 'disabledTuiAgents'>>
  | null
  | undefined

// Why a light module: the CLI's per-launch Codex preflight reads these without loading every hook service.
export function isAgentStatusHooksEnabled(
  settings: Partial<Pick<GlobalSettings, 'agentStatusHooksEnabled'>> | null | undefined
): boolean {
  return settings?.agentStatusHooksEnabled !== false
}

// Why: turning an agent off removes its hooks, so any install that reads only the global switch writes them back.
export function isAgentStatusHooksEnabledForAgent(
  settings: AgentStatusHooksSettings,
  agent: TuiAgent
): boolean {
  return (
    isAgentStatusHooksEnabled(settings) && isTuiAgentEnabled(agent, settings?.disabledTuiAgents)
  )
}
