import type { AgentSessionJournalIdentity } from '../../shared/agent-session-journal-types'
import type { OpenCodeAgentSessionAccountHome } from '../../shared/agent-session-account-home'
import { isLegacyAgentSessionAccountHome } from '../../shared/agent-session-account-home'
import { agentSessionProviderHandleChainHead } from '../../shared/agent-session-provider-handle'
import { resolveCliCommand } from '../../shared/node-cli-command-resolution'
import type { AgentSessionRecordStore } from '../runtime/agent-session-record-store'
import { supportsProviderProcessLocation } from '../provider-process/provider-location-support'
import { getManagedDataAccountService } from '../managed-data-accounts/service'
import { environmentForStructuredOpenCodeAccountHome } from './opencode-structured-account-home'
import type { OpenCodeStructuredLaunch } from './opencode-structured-session-state'
import { OPENCODE_SERVE_TRANSPORT } from './opencode-structured-agent-definition'
import { openCodeStructuredPermissionRules } from './opencode-structured-permission-policy'
import type { OpenCodePermissionRule } from './serve/native-protocol'

type OpenCodeAgent = 'opencode' | 'opencode2'

export type OpenCodeStructuredLaunchResolverDeps = {
  store: Pick<AgentSessionRecordStore, 'getRecord'>
  resolveWorkspacePath: (workspaceId: string) => Promise<string>
  resolveEnvironment: () => Promise<Record<string, string>>
  resolveLaunchEnv?: (
    agent: OpenCodeAgent
  ) => Promise<Record<string, string>> | Record<string, string>
  resolveCommand?: (
    agent: OpenCodeAgent,
    options: { pathEnv: string | null; homePath?: string }
  ) => string
  resolvePinnedEnvironment?: (
    account: OpenCodeAgentSessionAccountHome,
    environment: Record<string, string>
  ) => Promise<Record<string, string>> | Record<string, string>
  resolvePermissionRules?: (agent: OpenCodeAgent) => readonly OpenCodePermissionRule[]
  hasWindowsProcessStartTimeProof?: () => boolean
}

/** Every acquisition re-reads the durable account and conversation identity on its execution host. */
export function createOpenCodeStructuredLaunchResolver(
  deps: OpenCodeStructuredLaunchResolverDeps
): (input: { identity: AgentSessionJournalIdentity }) => Promise<OpenCodeStructuredLaunch> {
  return async ({ identity }) => {
    const record = deps.store.getRecord(identity.sessionId)
    if (!record || (record.provider !== 'opencode' && record.provider !== 'opencode2')) {
      throw new Error('OpenCode requires its own durable chat record')
    }
    if (!supportsProviderProcessLocation(record.location, deps.hasWindowsProcessStartTimeProof)) {
      throw new Error('OpenCode chat must run on the host that owns its workspace and process')
    }
    if (isLegacyAgentSessionAccountHome(record.accountHome)) {
      throw new Error('OpenCode chat requires a pinned data account')
    }
    const base = {
      ...(await deps.resolveEnvironment()),
      ...(await deps.resolveLaunchEnv?.(record.provider))
    }
    const environment = await (deps.resolvePinnedEnvironment
      ? deps.resolvePinnedEnvironment(record.accountHome, base)
      : environmentForStructuredOpenCodeAccountHome(record.accountHome, {
          managedAccounts: getManagedDataAccountService(),
          baseEnvironment: base
        }))
    const pathEnv = environment.PATH ?? environment.Path ?? null
    const homePath = environment.HOME ?? environment.USERPROFILE
    const command = (deps.resolveCommand ?? resolveCliCommand)(record.provider, {
      pathEnv,
      ...(homePath ? { homePath } : {})
    })
    const head = agentSessionProviderHandleChainHead(record.providerHandleChain)
    if (
      head &&
      (head.handle.transport !== OPENCODE_SERVE_TRANSPORT || head.handle.agent !== record.provider)
    ) {
      throw new Error('OpenCode cannot resume a conversation owned by a different transport')
    }
    return {
      command,
      cwd: await deps.resolveWorkspacePath(record.location.workspaceId),
      environment,
      resumeSessionId: head?.handle.nativeId ?? null,
      permissions:
        deps.resolvePermissionRules?.(record.provider) ?? openCodeStructuredPermissionRules(false),
      agent: record.provider,
      ...(record.options ? { options: record.options } : {})
    }
  }
}
