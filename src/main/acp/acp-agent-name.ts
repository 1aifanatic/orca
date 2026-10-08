import { TUI_AGENT_DISPLAY_NAMES } from '../../shared/tui-agent-display-names'
import { isTuiAgent } from '../../shared/tui-agent-config'

/** The name an ACP agent's chat rows and failures show. */
export function acpAgentName(agent: string): string {
  return isTuiAgent(agent) ? TUI_AGENT_DISPLAY_NAMES[agent] : agent
}
