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

const RelaySupport = z.object({
  agents: z.array(z.string()),
  versions: z.record(z.string(), z.string()).optional(),
  codexMaintenance: z.boolean().optional()
})
const supportedRelays = new WeakSet<object>()

export async function codexMaintenanceOnHost(
  params: CodexMaintenanceParams
): Promise<CodexMaintenanceState> {
  if (!params.connectionId) {
    return params.operation === 'start'
      ? codexMaintenanceRunner.start()
      : codexMaintenanceRunner.status(params.operation === 'read' ? params.jobId : undefined)
  }
  const mux = getActiveMultiplexer(params.connectionId)
  if (!mux || mux.isDisposed()) {
    throw new Error('Execution host is unavailable.')
  }
  if (supportedRelays.has(mux)) {
    return CodexMaintenanceStateSchema.parse(
      await mux.request('preflight.codexMaintenance', {
        operation: params.operation,
        jobId: params.jobId
      })
    )
  }
  const support = RelaySupport.parse(
    await mux.request('preflight.detectAgents', {
      reportCodexMaintenance: true,
      commands: [{ id: 'codex', cmd: 'codex', reportVersion: true }]
    })
  )
  if (support.codexMaintenance !== true) {
    const installation = codexCliInstallation(
      support.agents.includes('codex'),
      support.versions?.codex ?? null
    )
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
  supportedRelays.add(mux)
  // The relay owns the lock, child and log; contact loss never permits a local fallback.
  return CodexMaintenanceStateSchema.parse(
    await mux.request('preflight.codexMaintenance', {
      operation: params.operation,
      jobId: params.jobId
    })
  )
}
