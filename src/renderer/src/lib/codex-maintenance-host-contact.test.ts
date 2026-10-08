import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeStatus } from '../../../shared/runtime-types'
import { codexCliInstallation } from '../../../shared/codex-cli-installation'
import { subscribeCodexMaintenanceHostContact } from './codex-maintenance-host-contact'
import {
  getCodexMaintenanceEntry,
  refreshCodexMaintenance,
  resetCodexMaintenanceStoreForTests
} from './codex-maintenance-store'

const { call, listeners, hostState } = vi.hoisted(() => ({
  call: vi.fn(),
  listeners: new Set<() => void>(),
  hostState: {
    runtimeStatusByEnvironmentId: new Map<
      string,
      { status: RuntimeStatus | null; connectionGeneration: number; hostContactEpoch: number }
    >(),
    sshConnectionStates: new Map<string, { status: string; connectionGeneration: number }>(),
    refreshRemoteDetectedAgents: vi.fn().mockResolvedValue([])
  }
}))
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => hostState,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
}))
vi.mock('./codex-maintenance-client', () => ({
  callCodexMaintenance: call,
  codexMaintenanceTargetKey: (target: { kind: string }) =>
    target.kind === 'environment' ? 'runtime:host:codex' : 'ssh:host:codex'
}))
const TARGET = { kind: 'ssh', connectionId: 'host' } as const
function emit(status: string): void {
  hostState.sshConnectionStates.set('host', { status, connectionGeneration: 1 })
  for (const listener of listeners) {
    listener()
  }
}
beforeEach(() => {
  resetCodexMaintenanceStoreForTests()
  call.mockReset()
  emit('connected')
  hostState.runtimeStatusByEnvironmentId.clear()
})
afterEach(() => {
  listeners.clear()
  resetCodexMaintenanceStoreForTests()
})
describe('maintenance host contact lifecycle', () => {
  it('revalidates a paired runtime after contact loss and after a missed outage epoch changes', async () => {
    const target = { kind: 'environment', environmentId: 'host' } as const
    const status: RuntimeStatus = {
      runtimeId: 'host',
      rendererGraphEpoch: 0,
      graphStatus: 'ready',
      authoritativeWindowId: null,
      liveTabCount: 0,
      liveLeafCount: 0
    }
    const update = (live: boolean, epoch: number) => {
      hostState.runtimeStatusByEnvironmentId.set('host', {
        status: live ? status : null,
        connectionGeneration: 1,
        hostContactEpoch: epoch
      })
      for (const listener of listeners) {
        listener()
      }
    }
    update(true, 0)
    const unsubscribe = subscribeCodexMaintenanceHostContact(target)
    call.mockResolvedValue({
      installation: codexCliInstallation(true, '0.136.0'),
      action: null,
      canRun: true,
      job: null
    })
    await refreshCodexMaintenance(target)
    update(false, 0)
    expect(getCodexMaintenanceEntry('runtime:host:codex').verification).toBe('unverifiable')
    update(true, 1)
    await refreshCodexMaintenance(target)
    expect(call).toHaveBeenCalledTimes(2)
    update(true, 2)
    await refreshCodexMaintenance(target)
    expect(call).toHaveBeenCalledTimes(3)
    expect(getCodexMaintenanceEntry('runtime:host:codex').verification).toBe('current')
    unsubscribe()
    expect(listeners.size).toBe(0)
  })

  it('withdraws facts immediately on disconnect and rechecks on reconnect without a focus event', async () => {
    const unsubscribe = subscribeCodexMaintenanceHostContact(TARGET)
    call.mockResolvedValueOnce({
      installation: codexCliInstallation(true, '0.135.0'),
      action: null,
      canRun: true,
      job: null
    })
    await refreshCodexMaintenance(TARGET)
    expect(getCodexMaintenanceEntry('ssh:host:codex').verification).toBe('current')
    emit('disconnected')
    expect(getCodexMaintenanceEntry('ssh:host:codex').verification).toBe('unverifiable')
    call.mockResolvedValueOnce({
      installation: codexCliInstallation(true, '0.136.0'),
      action: null,
      canRun: true,
      job: null
    })
    emit('connected')
    await refreshCodexMaintenance(TARGET)
    expect(call).toHaveBeenCalledTimes(2)
    expect(getCodexMaintenanceEntry('ssh:host:codex').state?.installation.status).toBe('ready')
    unsubscribe()
    expect(listeners.size).toBe(0)
  })
})
