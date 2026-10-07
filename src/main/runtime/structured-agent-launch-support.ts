import type { AgentSessionExecutionLocation } from '../../shared/agent-session-record'
import type { StructuredAgentId } from '../../shared/agent-session-provider-handle'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { isAgentSessionRefusalError } from '../../shared/agent-session-wire-refusals'
import { nativeChatShellEnvironmentPolicy } from '../../shared/native-chat-shell-environment'
import { isTuiAgent } from '../../shared/tui-agent-config'
import { resolveTuiAgentLaunchEnv } from '../../shared/tui-agent-launch-defaults'
import type { ClaudeManagedAccountGateSettings } from '../native-chat/claude-structured-managed-account-support'
import {
  resolveStructuredAgentSessionCreateSupport,
  warnStructuredAgentSessionCreateUnsupported,
  type StructuredAgentSessionCreateSupport
} from '../native-chat/structured-agent-session-create-support'
import { resolveLoginShellEnvironment } from '../startup/login-shell-environment'
import { structuredAgentRuntimeRegistration } from './structured-agent-runtime-registrations'
import { structuredAgentBaseEnvironment } from './structured-agent-shell-environment'

type LaunchEnvironmentSettings = Pick<
  GlobalSettings,
  'agentDefaultEnv' | 'nativeChatInheritShellEnvironment' | 'nativeChatShellEnvironmentVariables'
> &
  Partial<Pick<GlobalSettings, 'agentCmdOverrides'>>

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

/** The agent's own check of what is installed on this host, with the environment and Command
 *  setting its launch starts from, in the workspace it would launch in; true for an agent whose
 *  location alone decides. */
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
  return supportsLaunch({ cwd, env, commandSettings: settings })
}

/** Whether the account a new chat would pin resolves on this host. False only for the host's own
 *  refusal (an account it cannot pin); any other failure is left for create to state. */
async function structuredAgentAccountPins(resolveAccountHome: () => Promise<unknown>) {
  try {
    await resolveAccountHome()
    return true
  } catch (error) {
    return !(
      isAgentSessionRefusalError(error) &&
      error.refusal.code === 'structured_agent_session_unsupported'
    )
  }
}

/** `agentSession.createSupport` on this host: every refusal it can know before spawning. The
 *  agent's location rule and installed-agent check from its registration, without installing the
 *  host; the account the new chat would pin, through the same resolver create uses (read-only
 *  here); then Claude's managed-account gate. A refusal logs which check said no. */
export async function resolveHostStructuredAgentCreateSupport(input: {
  agent: StructuredAgentId
  worktreeSelector: string
  location: AgentSessionExecutionLocation
  runtime: LaunchSupportRuntime
  getSettings: () => ClaudeManagedAccountGateSettings
  /** Resolves the account a new chat here would pin, without side effects. */
  resolveAccountHome: () => Promise<unknown>
}): Promise<StructuredAgentSessionCreateSupport> {
  const { agent, location } = input
  const supportsLocation =
    structuredAgentRuntimeRegistration(agent)?.supportsLocation(location) ?? false
  const supportsLaunch =
    supportsLocation &&
    (await structuredAgentSupportsLaunch(agent, input.worktreeSelector, input.runtime))
  const pinsAccount = supportsLaunch && (await structuredAgentAccountPins(input.resolveAccountHome))
  const support = resolveStructuredAgentSessionCreateSupport({
    agent,
    location,
    adapterSupportsCreate: pinsAccount,
    getSettings: input.getSettings
  })
  warnStructuredAgentSessionCreateUnsupported(
    agent,
    support,
    !supportsLocation
      ? 'location'
      : !supportsLaunch
        ? 'installed-agent'
        : !pinsAccount
          ? 'account-pin'
          : 'managed-account'
  )
  return support
}
