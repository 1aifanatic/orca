import { z } from 'zod'
import { codexCliInstallation } from '../../shared/codex-cli-installation'
import {
  codexMaintenanceAction,
  CodexMaintenanceStateSchema,
  type CodexMaintenanceParams,
  type CodexMaintenanceState
} from '../../shared/codex-cli-maintenance'
import { getActiveMultiplexer } from '../ssh/ssh-target-registry'
import { codexMaintenanceRunner } from './codex-maintenance-runner'
import type { CodexCommandSettings } from '../codex/configured-codex-invocation'

const RelaySupport = z.object({
  agents: z.array(z.string()),
  versions: z.record(z.string(), z.string()).optional(),
  codexMaintenance: z.boolean().optional(),
  codexMaintenanceContext: z.boolean().optional()
})
const supportedRelays = new WeakMap<object, boolean>()

export async function codexMaintenanceOnHost(
  params: CodexMaintenanceParams,
  settings: CodexCommandSettings = {}
): Promise<CodexMaintenanceState> {
  const commandSettings = {
    agentCmdOverrides: { codex: settings.agentCmdOverrides?.codex },
    agentDefaultEnv: { codex: settings.agentDefaultEnv?.codex },
    nativeChatInheritShellEnvironment: settings.nativeChatInheritShellEnvironment,
    nativeChatShellEnvironmentVariables: settings.nativeChatShellEnvironmentVariables
  }
  const context = { cwd: params.cwd, commandSettings }
  if (!params.connectionId) {
    return params.operation === 'start'
      ? codexMaintenanceRunner.start(context)
      : codexMaintenanceRunner.status(
          params.operation === 'read' ? params.jobId : undefined,
          context
        )
  }
  const mux = getActiveMultiplexer(params.connectionId)
  if (!mux || mux.isDisposed()) {
    throw new Error('Execution host is unavailable.')
  }
  const contextRequired = Boolean(
    params.cwd ||
    commandSettings.agentCmdOverrides.codex?.trim() ||
    Object.keys(commandSettings.agentDefaultEnv.codex ?? {}).length ||
    commandSettings.nativeChatInheritShellEnvironment === false ||
    commandSettings.nativeChatShellEnvironmentVariables?.length
  )
  const cached = supportedRelays.get(mux)
  if (cached !== undefined && (!contextRequired || cached)) {
    return CodexMaintenanceStateSchema.parse(
      await mux.request('preflight.codexMaintenance', {
        operation: params.operation,
        jobId: params.jobId,
        ...context
      })
    )
  }
  const support = RelaySupport.parse(
    await mux.request('preflight.detectAgents', {
      reportCodexMaintenance: true,
      commands: [{ id: 'codex', cmd: 'codex', reportVersion: true }]
    })
  )
  if (
    support.codexMaintenance !== true ||
    (contextRequired && support.codexMaintenanceContext !== true)
  ) {
    const installation = contextRequired
      ? codexCliInstallation(true, null)
      : codexCliInstallation(support.agents.includes('codex'), support.versions?.codex ?? null)
    if (params.operation === 'start') {
      throw new Error('Execution host does not support Codex maintenance.')
    }
    return {
      installation,
      action: codexMaintenanceAction(installation, true),
      canRun: false,
      job: null
    }
  }
  supportedRelays.set(mux, support.codexMaintenanceContext === true)
  // The relay owns the lock, child and log; contact loss never permits a local fallback.
  return CodexMaintenanceStateSchema.parse(
    await mux.request('preflight.codexMaintenance', {
      operation: params.operation,
      jobId: params.jobId,
      ...context
    })
  )
}
