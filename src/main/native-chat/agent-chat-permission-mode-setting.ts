import type { GlobalSettings } from '../../shared/global-settings-types'
import type { TuiAgent } from '../../shared/tui-agent'
import {
  agentChatLaunchPermissionMode,
  type AgentChatPermissionMode
} from '../../shared/agent-chat-permission-mode'

export function agentChatPermissionModeForSettings(
  agent: TuiAgent,
  settings: Partial<Pick<GlobalSettings, 'nativeChatPermissionMode'>> | null | undefined
): AgentChatPermissionMode {
  return agentChatLaunchPermissionMode(agent, null, settings?.nativeChatPermissionMode)
}
