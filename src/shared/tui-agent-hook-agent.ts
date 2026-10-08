import { isTuiAgent, TUI_AGENT_CONFIG } from './tui-agent-config'

/** The agent a launched agent's hook events name (the catalog's `hookAgent`, else the launch). */
export function getTuiAgentHookAgent(launchAgent: string): string {
  return (isTuiAgent(launchAgent) && TUI_AGENT_CONFIG[launchAgent].hookAgent) || launchAgent
}
