import type { GlobalSettings } from '../../shared/global-settings-types'
import type { TuiAgent } from '../../shared/tui-agent'
import {
  AGENT_CHAT_PERMISSION_MODE_OPTION_ID,
  agentChatLaunchPermissionMode,
  type AgentChatPermissionMode
} from '../../shared/agent-chat-permission-mode'

export function agentChatPermissionModeForSettings(
  agent: TuiAgent,
  settings: Partial<Pick<GlobalSettings, 'nativeChatPermissionMode'>> | null | undefined
): AgentChatPermissionMode {
  return agentChatLaunchPermissionMode(agent, null, settings?.nativeChatPermissionMode)
}

/** A new chat's seed options with the chat permission default; `forLaunch` leaves Claude's
 *  inherited middle modes out, since it settles them after discovering support, before its first
 *  message. */
export function withAgentChatPermissionSeed(
  agent: TuiAgent,
  settings: Partial<Pick<GlobalSettings, 'nativeChatPermissionMode'>>,
  seeded: Record<string, string> | undefined,
  forLaunch: boolean
): Record<string, string> | undefined {
  if (agent !== 'claude' && agent !== 'codex') {
    return seeded
  }
  const permissionMode = agentChatPermissionModeForSettings(agent, settings)
  if (
    forLaunch &&
    agent === 'claude' &&
    (permissionMode === 'auto' || permissionMode === 'accept-edits')
  ) {
    return seeded
  }
  return { ...seeded, [AGENT_CHAT_PERMISSION_MODE_OPTION_ID]: permissionMode }
}
