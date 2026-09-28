import { agentTabsDefaultToNativeChat } from '../../../shared/structured-native-chat-launch-route'
import { pickTuiAgent } from '../../../shared/tui-agent-selection'
import { useAppStore } from '@/store'
import { getConnectionId } from '@/lib/connection-context'
import { workspaceKindForWorktreeId } from '@/lib/agent-launch-route-input'
import { planAgentSessionLaunch } from '@/lib/agent-session-launch-plan'
import { launchAgentInNewTab } from '@/lib/launch-agent-in-new-tab'

/**
 * When the user's new agent tabs open as chat, an empty workspace opens their default agent as a
 * chat instead of a bare shell. Null means nothing opened and the caller seeds the shell.
 */
export function openDefaultAgentChatInEmptyWorkspace(
  worktreeId: string
): { primaryTabId: string | null } | null {
  const state = useAppStore.getState()
  if (!agentTabsDefaultToNativeChat(state.settings)) {
    return null
  }
  const connectionId = getConnectionId(worktreeId)
  const detectedAgentIds =
    typeof connectionId === 'string'
      ? state.remoteDetectedAgentIds[connectionId]
      : state.detectedAgentIds
  // Why: a 'blank' default means the user wants workspaces to open without an agent.
  const agent = pickTuiAgent(
    state.settings?.defaultTuiAgent,
    detectedAgentIds ?? [],
    state.settings?.disabledTuiAgents
  )
  if (!agent) {
    return null
  }
  const agentSessionLaunchPlan = planAgentSessionLaunch(state, {
    agent,
    workspace: { kind: workspaceKindForWorktreeId(worktreeId), worktreeId }
  })
  // Why: an agent that can only open as a TUI here would replace the shell with a process nobody asked for.
  if (agentSessionLaunchPlan.route === 'terminal-tui') {
    return null
  }
  const result = launchAgentInNewTab({
    agent,
    worktreeId,
    launchSource: 'unknown',
    agentSessionLaunchPlan,
    pendingActivationSpawn: true
  })
  if (!result) {
    return null
  }
  return { primaryTabId: result.surface.kind === 'host-published' ? null : result.surface.tabId }
}
