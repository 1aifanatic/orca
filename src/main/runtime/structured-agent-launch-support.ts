import type { GlobalSettings } from '../../shared/global-settings-types'
import { nativeChatShellEnvironmentPolicy } from '../../shared/native-chat-shell-environment'
import { isTuiAgent } from '../../shared/tui-agent-config'
import { resolveTuiAgentLaunchEnv } from '../../shared/tui-agent-launch-defaults'
import { resolveLoginShellEnvironment } from '../startup/login-shell-environment'
import { structuredAgentRuntimeRegistration } from './structured-agent-runtime-registrations'
import { structuredAgentBaseEnvironment } from './structured-agent-shell-environment'

type LaunchEnvironmentSettings = Pick<
  GlobalSettings,
  'agentDefaultEnv' | 'nativeChatInheritShellEnvironment' | 'nativeChatShellEnvironmentVariables'
>

/** The environment every agent's launch on this host starts from, for a check made before the
 *  session host is built. */
export async function resolveHostStructuredAgentBaseEnvironment(
  settings: LaunchEnvironmentSettings
): Promise<Record<string, string>> {
  return structuredAgentBaseEnvironment({
    shellEnv: await resolveLoginShellEnvironment(),
    policy: nativeChatShellEnvironmentPolicy(settings)
  })
}

/** What the check reads from the runtime asking it. */
type LaunchSupportRuntime = {
  requireStore(): { getSettings(): LaunchEnvironmentSettings }
  resolveRuntimeFileTarget(selector: string): Promise<{ worktree: { path: string } }>
}

/** The agent's own check of what is installed on this host, with the environment its launch starts
 *  from, in the workspace it would launch in; true for an agent whose location alone decides. */
export async function structuredAgentSupportsLaunch(
  agent: string,
  worktreeSelector: string,
  runtime: LaunchSupportRuntime
): Promise<boolean> {
  const supportsLaunch = structuredAgentRuntimeRegistration(agent)?.supportsLaunch
  if (!supportsLaunch) {
    return true
  }
  const settings = runtime.requireStore().getSettings()
  const env = {
    ...(await resolveHostStructuredAgentBaseEnvironment(settings)),
    ...(isTuiAgent(agent) ? resolveTuiAgentLaunchEnv(agent, settings.agentDefaultEnv) : {})
  }
  const cwd = (await runtime.resolveRuntimeFileTarget(worktreeSelector)).worktree.path
  return supportsLaunch({ cwd, env })
}
