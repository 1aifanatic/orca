// The structured agents this runtime registers, in one list. Each entry's definition decides which
// agents' records the store admits, and its factory builds the adapter the router drives that agent
// with once the store is open, so storage and routing cannot disagree about which agents exist.
// Adding an agent is one more entry.

import { createCodexStructuredLaunchResolver } from '../codex/codex-structured-launch-resolution'
import { CodexStructuredSessionAdapter } from '../codex/codex-structured-session-adapter'
import { CODEX_STRUCTURED_AGENT } from '../codex/codex-structured-agent-definition'
import { CLAUDE_STRUCTURED_AGENT } from '../claude/claude-structured-agent-definition'
import {
  agentSessionStoredAgents,
  type AgentSessionStoredAgents
} from '../../shared/agent-session-stored-agent'
import type {
  StructuredAgentSessionAdapter,
  StructuredAgentSessionLifecycleEvent
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { StructuredAgentDefinition } from '../native-chat/agent-session-wire/structured-agent-definition'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import { readClaudeManagedAccountGateSettings } from '../native-chat/claude-structured-managed-account-support'
import { agentModelCatalogStore } from '../native-chat/agent-model-catalog/agent-model-catalog-store'
import type { AgentSessionRecordStore } from './agent-session-record-store'
import type { createStructuredAgentSessionDispatchFollowUps } from './structured-agent-session-dispatch-followups'
import type { StructuredAgentSessionRuntimeDeps } from './structured-agent-session-runtime'
import type { createStructuredAgentEnvironmentResolvers } from './structured-agent-shell-environment'
import { createStructuredClaudeRuntimeAdapter } from './structured-claude-runtime-adapter'

/** What an agent's adapter is built from: the open store and the runtime around it. */
export type StructuredAgentAdapterContext = {
  deps: StructuredAgentSessionRuntimeDeps
  store: AgentSessionRecordStore
  environment: ReturnType<typeof createStructuredAgentEnvironmentResolvers>
  /** Hands the host an exit or other lifecycle event the agent observed. */
  deliverLifecycle: (event: StructuredAgentSessionLifecycleEvent) => void
  followUps: ReturnType<typeof createStructuredAgentSessionDispatchFollowUps>
  /** Null until the host is built: the adapters are built first. */
  host: () => StructuredAgentSessionHost | null
}

export type StructuredAgentRuntimeAdapter = StructuredAgentSessionAdapter & {
  closeAll: () => Promise<void>
  /** Resolves once exits the agent observed have been published; absent when it publishes at once. */
  drainObservedExits?: () => Promise<void>
}

export type StructuredAgentRuntimeRegistration = {
  definition: StructuredAgentDefinition
  createAdapter: (context: StructuredAgentAdapterContext) => StructuredAgentRuntimeAdapter
}

function createCodexAdapter(context: StructuredAgentAdapterContext): StructuredAgentRuntimeAdapter {
  const { deps, store, followUps, host } = context
  return new CodexStructuredSessionAdapter({
    resolveLaunch: createCodexStructuredLaunchResolver({
      store,
      resolveWorkspacePath: deps.resolveWorkspacePath,
      resolveEnvironment: context.environment.resolveCodexEnvironment,
      ...(deps.resolveCodexPermissionPolicy
        ? { resolvePermissionPolicy: deps.resolveCodexPermissionPolicy }
        : {}),
      ...(deps.resolveCodexCommand ? { resolveCommand: deps.resolveCodexCommand } : {})
    }),
    ...(deps.openCodexConnection ? { openConnection: deps.openCodexConnection } : {}),
    ...(deps.readProcessStartTime ? { readProcessStartTime: deps.readProcessStartTime } : {}),
    modelCatalog: agentModelCatalogStore,
    onChildWorkEvidence: (sessionId, evidence) =>
      host()?.publishChildWorkEvidence(sessionId, evidence),
    onDispatchSettledLate: followUps.onDispatchSettledLate,
    onPrimaryThreadStoppedRunning: followUps.releaseUnansweredDispatches,
    logger: deps.logger,
    onEvent: (event) => {
      // Every exit, expected or not: the host ends that child's record.
      if (event.type === 'ended' && 'cause' in event) {
        context.deliverLifecycle(event)
      }
    }
  })
}

function createClaudeAdapter(
  context: StructuredAgentAdapterContext
): StructuredAgentRuntimeAdapter {
  const { deps, store, followUps, host } = context
  return createStructuredClaudeRuntimeAdapter({
    store,
    resolveWorkspacePath: deps.resolveWorkspacePath,
    ...(deps.resolveClaudeCommand ? { resolveClaudeCommand: deps.resolveClaudeCommand } : {}),
    ...(deps.resolveClaudeLaunchEnv ? { resolveClaudeLaunchEnv: deps.resolveClaudeLaunchEnv } : {}),
    resolveClaudeInheritedEnv: context.environment.resolveClaudeInheritedEnv,
    resolveClaudeAuthPolicy: deps.resolveClaudeAuthPolicy,
    ...(deps.resolveClaudePermissionMode
      ? { resolveClaudePermissionMode: deps.resolveClaudePermissionMode }
      : {}),
    ...(deps.getClaudeManagedAccountGateSettings
      ? {
          readClaudeManagedAccountGate: () =>
            readClaudeManagedAccountGateSettings(deps.getClaudeManagedAccountGateSettings!)
        }
      : {}),
    onLifecycleEvent: context.deliverLifecycle,
    logger: deps.logger,
    onChildWorkEvidence: (sessionId, evidence) =>
      host()?.publishChildWorkEvidence(sessionId, evidence),
    onDispatchSettledLate: followUps.onDispatchSettledLate,
    onSessionIdle: followUps.releaseUnansweredDispatches,
    ...(deps.openClaudeConnection ? { openClaudeConnection: deps.openClaudeConnection } : {}),
    ...(deps.readProcessStartTime ? { readProcessStartTime: deps.readProcessStartTime } : {}),
    modelCatalog: agentModelCatalogStore
  })
}

export const STRUCTURED_AGENT_RUNTIME_REGISTRATIONS: readonly StructuredAgentRuntimeRegistration[] =
  [
    { definition: CODEX_STRUCTURED_AGENT, createAdapter: createCodexAdapter },
    { definition: CLAUDE_STRUCTURED_AGENT, createAdapter: createClaudeAdapter }
  ]

/** What the record store admits: exactly the registered agents' declared storage. */
export const STRUCTURED_AGENT_STORAGE: AgentSessionStoredAgents = agentSessionStoredAgents(
  STRUCTURED_AGENT_RUNTIME_REGISTRATIONS.map((registration) => registration.definition)
)
