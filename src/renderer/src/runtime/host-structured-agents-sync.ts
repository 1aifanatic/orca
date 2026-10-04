import { LOCAL_EXECUTION_HOST_ID, toRuntimeExecutionHostId } from '../../../shared/execution-host'
import { lastVerifiedRuntimeStatus } from '../../../shared/runtime-host-status'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { loadHostStructuredAgents, retainHostStructuredAgents } from './host-structured-agents'
import { ensureLocalRuntimeCapabilities } from './local-runtime-capabilities'

function syncPairedHosts(statuses: AppState['runtimeStatusByEnvironmentId']): void {
  const hostIds = new Set<string>([LOCAL_EXECUTION_HOST_ID])
  for (const [environmentId, entry] of statuses) {
    const executionHostId = toRuntimeExecutionHostId(environmentId)
    hostIds.add(executionHostId)
    const status = lastVerifiedRuntimeStatus(entry)
    if (status) {
      void loadHostStructuredAgents(executionHostId, status.capabilities, status.runtimeId)
    }
  }
  retainHostStructuredAgents(hostIds)
}

/** Reads each host's registered agents once its status says it publishes them, and again when a
 *  paired host's runtime changes. Returns the unsubscribe. */
export function installHostStructuredAgentsSync(): () => void {
  void ensureLocalRuntimeCapabilities().then((capabilities) =>
    loadHostStructuredAgents(LOCAL_EXECUTION_HOST_ID, capabilities, null)
  )
  syncPairedHosts(useAppStore.getState().runtimeStatusByEnvironmentId)
  return useAppStore.subscribe((state, previousState) => {
    if (state.runtimeStatusByEnvironmentId !== previousState.runtimeStatusByEnvironmentId) {
      syncPairedHosts(state.runtimeStatusByEnvironmentId)
    }
  })
}
