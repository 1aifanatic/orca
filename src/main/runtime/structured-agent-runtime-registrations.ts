// Each runtime registration owns its adapter, location support and account resolution at start.

import { createCodexStructuredLaunchResolver } from '../codex/codex-structured-launch-resolution'
import { supportsCodexStructuredLocation } from '../codex/codex-structured-location-support'
import { supportsClaudeStructuredLocation } from '../claude/claude-structured-location-support'
import { applyStructuredCodexWorkspaceTrust } from '../agent-workspace-trust-spawn'
import type { AgentSessionExecutionLocation } from '../../shared/agent-session-record'
import {
  agentSessionAccountHome,
  type AgentSessionAccountHome
} from '../../shared/agent-session-account-home'
import { CodexStructuredSessionAdapter } from '../codex/codex-structured-session-adapter'
import { CODEX_STRUCTURED_AGENT } from '../codex/codex-structured-agent-definition'
import { CLAUDE_STRUCTURED_AGENT } from '../claude/claude-structured-agent-definition'
import {
  OPENCODE_STRUCTURED_AGENT,
  OPENCODE2_STRUCTURED_AGENT
} from '../opencode/opencode-structured-agent-definition'
import { OpenCodeStructuredSessionAdapter } from '../opencode/opencode-structured-session-adapter'
import { createOpenCodeStructuredLaunchResolver } from '../opencode/opencode-structured-launch-resolution'
import { resolveStructuredOpenCodeAccountHome } from '../opencode/opencode-structured-account-home'
import { getManagedDataAccountService } from '../managed-data-accounts/service'
import { supportsProviderProcessLocation } from '../provider-process/provider-location-support'
import type {
  StructuredAgentSessionAdapter,
  StructuredAgentSessionLifecycleEvent
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { StructuredAgentDefinition } from '../native-chat/agent-session-wire/structured-agent-definition'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import { readClaudeManagedAccountGateSettings } from '../native-chat/claude-structured-managed-account-support'
import { agentModelCatalogStore } from '../native-chat/agent-model-catalog/agent-model-catalog-store'
import { agentModelCatalogFingerprintForRecord } from '../native-chat/agent-model-catalog/agent-model-catalog-fingerprint'
import type { AgentSessionRecordStore } from './agent-session-record-store'
import type { createStructuredAgentSessionDispatchFollowUps } from './structured-agent-session-dispatch-followups'
import type { StructuredAgentSessionRuntimeDeps } from './structured-agent-session-runtime'
import type { createStructuredAgentEnvironmentResolvers } from './structured-agent-shell-environment'
import { createStructuredClaudeRuntimeAdapter } from './structured-claude-runtime-adapter'
import {
  resolveStructuredClaudeAccountHomePath,
  resolveStructuredCodexAccountHomePath,
  type StructuredClaudeAccountHomeDeps,
  type StructuredCodexAccountHomeDeps
} from './structured-agent-account-home'

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

/** Which account home a chat of an agent pins, asked on the host that runs it. */
export type StructuredAgentAccountHomeRequest = {
  launchEnv: NodeJS.ProcessEnv
  /** Where the chat runs; null for a read with no workspace (the model catalog). */
  location: AgentSessionExecutionLocation | null
  /** A `read` has no side effects: it syncs no home, starts no bridge, clears no selection. */
  purpose: 'launch' | 'read'
  /** The launch's workspace directory on this host; a read has none. */
  workspacePath: (() => Promise<string>) | null
}

/** What resolving an account may ask of the runtime around it. */
export type StructuredAgentAccountHomeServices = {
  getClaudeConfigDirectory: StructuredClaudeAccountHomeDeps['getClaudeConfigDirectory']
  /** Codex's home for a launch, prepared for it; and the same answer with no side effects. */
  prepareCodexLaunchHome: StructuredCodexAccountHomeDeps['resolveLaunchHome']
  readCodexLaunchHome: StructuredCodexAccountHomeDeps['resolveLaunchHome']
  resolveProviderEnvironment: () => Promise<Record<string, string>>
  workspaceTrustSettings: () => Parameters<typeof applyStructuredCodexWorkspaceTrust>[0]['settings']
}

export type StructuredAgentRuntimeRegistration = {
  definition: StructuredAgentDefinition
  createAdapter: (context: StructuredAgentAdapterContext) => StructuredAgentRuntimeAdapter
  /** Whether this agent's chats can run at `location`; answered without building the host. */
  supportsLocation: (location: AgentSessionExecutionLocation) => boolean
  /** The account home a chat of this agent pins; see `StructuredAgentAccountHomeRequest`. */
  resolveAccountHome: (
    request: StructuredAgentAccountHomeRequest,
    services: StructuredAgentAccountHomeServices
  ) => Promise<AgentSessionAccountHome>
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
    ...(deps.claudeThinkingDisplay ? { claudeThinkingDisplay: deps.claudeThinkingDisplay } : {}),
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

async function resolveCodexAccountHomePath(
  request: StructuredAgentAccountHomeRequest,
  services: StructuredAgentAccountHomeServices
): Promise<string> {
  const { launchEnv, purpose, workspacePath } = request
  if (purpose === 'launch' && workspacePath) {
    await applyStructuredCodexWorkspaceTrust({
      workspacePath: await workspacePath(),
      launchEnv,
      settings: services.workspaceTrustSettings()
    })
  }
  return resolveStructuredCodexAccountHomePath({
    launchEnv,
    resolveLaunchHome:
      purpose === 'launch' ? services.prepareCodexLaunchHome : services.readCodexLaunchHome
  })
}

function createOpenCodeAdapter(
  context: StructuredAgentAdapterContext
): StructuredAgentRuntimeAdapter {
  const { deps, store, followUps, host } = context
  return new OpenCodeStructuredSessionAdapter({
    resolveLaunch: createOpenCodeStructuredLaunchResolver({
      store,
      resolveWorkspacePath: deps.resolveWorkspacePath,
      resolveEnvironment: context.environment.resolveProviderEnvironment,
      ...(deps.resolveOpenCodeCommand ? { resolveCommand: deps.resolveOpenCodeCommand } : {}),
      ...(deps.resolveOpenCodeLaunchEnv ? { resolveLaunchEnv: deps.resolveOpenCodeLaunchEnv } : {}),
      ...(deps.resolveOpenCodePermissionRules
        ? { resolvePermissionRules: deps.resolveOpenCodePermissionRules }
        : {}),
      ...(deps.resolveOpenCodePinnedEnvironment
        ? { resolvePinnedEnvironment: deps.resolveOpenCodePinnedEnvironment }
        : {})
    }),
    ...(deps.openOpenCodeServer ? { openServer: deps.openOpenCodeServer } : {}),
    ...(deps.readProcessStartTime ? { readProcessStartTime: deps.readProcessStartTime } : {}),
    onEvent: context.deliverLifecycle,
    onCatalog: (sessionId, models) => {
      const record = store.getRecord(sessionId)
      if (record) {
        agentModelCatalogStore.recordSuccess(
          agentModelCatalogFingerprintForRecord(record),
          record.provider,
          { models: [...models], fastModeTierByModel: new Map(), origin: 'live-session' }
        )
      }
    },
    onChildWorkEvidence: (sessionId, evidence) =>
      host()?.publishChildWorkEvidence(sessionId, evidence),
    onDispatchSettledLate: followUps.onDispatchSettledLate,
    onPrimaryThreadStoppedRunning: followUps.releaseUnansweredDispatches,
    logger: deps.logger
  })
}

function openCodeRegistration(
  definition: StructuredAgentDefinition
): StructuredAgentRuntimeRegistration {
  return {
    definition,
    createAdapter: createOpenCodeAdapter,
    supportsLocation: supportsProviderProcessLocation,
    resolveAccountHome: async ({ launchEnv }, services) => {
      const managedAccounts = getManagedDataAccountService()
      return resolveStructuredOpenCodeAccountHome({
        baseEnvironment: await services.resolveProviderEnvironment(),
        launchEnv,
        managedAccounts
      })
    }
  }
}

export const STRUCTURED_AGENT_RUNTIME_REGISTRATIONS: readonly StructuredAgentRuntimeRegistration[] =
  [
    {
      definition: CODEX_STRUCTURED_AGENT,
      createAdapter: createCodexAdapter,
      supportsLocation: (location) => supportsCodexStructuredLocation(location),
      resolveAccountHome: async (request, services) =>
        agentSessionAccountHome(
          CODEX_STRUCTURED_AGENT,
          await resolveCodexAccountHomePath(request, services)
        )
    },
    {
      definition: CLAUDE_STRUCTURED_AGENT,
      createAdapter: createClaudeAdapter,
      supportsLocation: supportsClaudeStructuredLocation,
      resolveAccountHome: async ({ launchEnv, location }, services) =>
        agentSessionAccountHome(
          CLAUDE_STRUCTURED_AGENT,
          resolveStructuredClaudeAccountHomePath({
            launchEnv,
            wslDistro: location?.wslDistro ?? null,
            getClaudeConfigDirectory: services.getClaudeConfigDirectory
          })
        )
    },
    openCodeRegistration(OPENCODE_STRUCTURED_AGENT),
    openCodeRegistration(OPENCODE2_STRUCTURED_AGENT)
  ]

/** The registration of `agent`; null for an agent this runtime does not drive. */
export function structuredAgentRuntimeRegistration(
  agent: string
): StructuredAgentRuntimeRegistration | null {
  return (
    STRUCTURED_AGENT_RUNTIME_REGISTRATIONS.find(({ definition }) => definition.agent === agent) ??
    null
  )
}
