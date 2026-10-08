import { useAppStore } from '@/store'
import { runtimeHostContactForEntry } from '../../../shared/runtime-host-contact'
import type { CodexMaintenanceTarget } from './codex-maintenance-client'
import {
  invalidateCodexMaintenanceContact,
  refreshCodexMaintenance
} from './codex-maintenance-store'

function contact(target: CodexMaintenanceTarget): string {
  const state = useAppStore.getState()
  if (target.kind === 'ssh') {
    const entry = state.sshConnectionStates?.get(target.connectionId)
    return `${entry?.status ?? 'unknown'}:${entry?.connectionGeneration ?? 0}`
  }
  if (target.kind === 'environment') {
    const entry = state.runtimeStatusByEnvironmentId?.get(target.environmentId)
    return `${runtimeHostContactForEntry(entry).verdict}:${entry?.connectionGeneration ?? 0}:${entry?.hostContactEpoch ?? 0}`
  }
  return 'live'
}

export function codexMaintenanceHostIsReachable(target: CodexMaintenanceTarget): boolean {
  const current = contact(target)
  return current === 'live' || current.startsWith('live:') || current.startsWith('connected:')
}

export function subscribeCodexMaintenanceHostContact(target: CodexMaintenanceTarget): () => void {
  let previous = contact(target)
  return useAppStore.subscribe(() => {
    const current = contact(target)
    if (current === previous) {
      return
    }
    previous = current
    invalidateCodexMaintenanceContact(target)
    if (current.startsWith('live:') || current.startsWith('connected:')) {
      void refreshCodexMaintenance(target)
    }
  })
}
