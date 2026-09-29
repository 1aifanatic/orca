import { TUI_AGENT_CONFIG, isTuiAgent } from '../shared/tui-agent-config'
import type { GlobalSettings } from '../shared/global-settings-types'
import { resolveTerminalWorkspacePath } from '../shared/terminal-startup-cwd'
import {
  applyAgentWorkspaceTrust,
  type AgentTrustLaunchContext,
  type AgentTrustSpawnFields
} from './agent-workspace-trust'

/**
 * The one place Orca pre-trusts a workspace: every Orca-started agent PTY passes
 * through a spawn builder with its declared `launchAgent`, which survives setup-script
 * wrapping. Reattaches and restores are skipped so trust is never re-run for them.
 * Returns null when there is nothing to write, so other spawns take no extra tick:
 * the builders arbitrate pane-spawn reservation races that a tick can reorder.
 */
export function applyAgentWorkspaceTrustToSpawn(
  args: {
    launchAgent: unknown
    /** Worktree or folder workspace id; its root is the folder the agent is trusted in. */
    worktreeId: string | undefined
    store: { getFolderWorkspace: (id: string) => { folderPath: string } | undefined } | undefined
    isFreshLaunch: boolean
    settings: Pick<GlobalSettings, 'agentWorkspaceTrustEnabled'> | null | undefined
    spawnOptions: AgentTrustSpawnFields
  } & AgentTrustLaunchContext
): Promise<void> | null {
  if (!args.isFreshLaunch || args.settings?.agentWorkspaceTrustEnabled === false) {
    return null
  }
  const preset = isTuiAgent(args.launchAgent)
    ? TUI_AGENT_CONFIG[args.launchAgent].preflightTrust
    : undefined
  const workspacePath = resolveTerminalWorkspacePath(
    args.worktreeId,
    (folderWorkspaceId) => args.store?.getFolderWorkspace(folderWorkspaceId)?.folderPath
  )
  if (!preset || !workspacePath) {
    return null
  }
  return applyAgentWorkspaceTrust(preset, workspacePath, {
    env: args.env,
    claudeAuth: args.claudeAuth,
    wslDistro: args.wslDistro,
    connectionId: args.connectionId
  }).then((fields) => {
    if (fields.claudeFolderTrust) {
      args.spawnOptions.claudeFolderTrust = fields.claudeFolderTrust
    }
  })
}
