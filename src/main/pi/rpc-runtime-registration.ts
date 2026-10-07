import { homedir } from 'node:os'
import { join } from 'node:path'
import { agentSessionAccountHome } from '../../shared/agent-session-account-home'
import { supportsSupervisedProviderChildLocation } from '../provider-process/supervised-provider-child-location'
import type {
  StructuredAgentAdapterContext,
  StructuredAgentRuntimeAdapter,
  StructuredAgentRuntimeRegistration
} from '../runtime/structured-agent-runtime-registrations'
import { PI_RPC_AGENT } from './rpc-agent-definition'
import { createPiRpcLaunchResolver } from './rpc-launch-resolution'
import { PiRpcSessionAdapter } from './rpc-session-adapter'
import { probePiRpcVersion, resolvePiRpcCommand } from './rpc-version'

function createPiRpcAdapter(context: StructuredAgentAdapterContext): StructuredAgentRuntimeAdapter {
  const { deps } = context
  return new PiRpcSessionAdapter({
    resolveLaunch: createPiRpcLaunchResolver({
      store: context.store,
      resolveWorkspacePath: deps.resolveWorkspacePath,
      resolveEnvironment: async () => ({
        ...(await context.environment.resolveBaseEnvironment()),
        ...(await deps.resolvePiLaunchEnv?.())
      }),
      ...(deps.resolvePiCommand ? { resolveCommand: deps.resolvePiCommand } : {})
    }),
    ...(deps.openPiConnection ? { openConnection: deps.openPiConnection } : {}),
    ...(deps.readProcessStartTime ? { readProcessStartTime: deps.readProcessStartTime } : {}),
    onLifecycle: context.deliverLifecycle,
    onSettled: ({ sessionId, clientMessageId, outcome }) => {
      if (outcome.state === 'admitted') {
        return
      }
      context.followUps.onDispatchSettledLate({
        sessionId,
        clientMessageId,
        ...(outcome.state === 'accepted' ? { providerIdentity: outcome.providerIdentity } : outcome)
      })
    },
    onIdle: context.followUps.releaseUnansweredDispatches,
    logger: deps.logger
  })
}

export const PI_RPC_RUNTIME_REGISTRATION: StructuredAgentRuntimeRegistration = {
  definition: PI_RPC_AGENT,
  createAdapter: createPiRpcAdapter,
  supportsLocation: supportsSupervisedProviderChildLocation,
  supportsLaunch: ({ cwd, env }) =>
    probePiRpcVersion({ program: resolvePiRpcCommand(env), cwd, env }),
  resolveAccountHome: async ({ launchEnv }) =>
    agentSessionAccountHome(
      PI_RPC_AGENT,
      launchEnv.PI_CODING_AGENT_DIR?.trim() || join(homedir(), '.pi', 'agent')
    )
}
