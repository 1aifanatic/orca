import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { codexCliInstallation } from '../../../shared/codex-cli-installation'
import {
  codexMaintenanceAction,
  type CodexMaintenanceState
} from '../../../shared/codex-cli-maintenance'
import {
  getCodexMaintenanceEntry,
  refreshCodexMaintenance,
  resetCodexMaintenanceStoreForTests,
  startCodexMaintenance
} from './codex-maintenance-store'

const { call, refreshAgents } = vi.hoisted(() => ({
  call: vi.fn(),
  refreshAgents: vi.fn().mockResolvedValue([])
}))
vi.mock('./codex-maintenance-client', () => ({
  callCodexMaintenance: call,
  codexMaintenanceTargetKey: () => 'local:codex'
}))
vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({ refreshDetectedAgents: refreshAgents }) }
}))
const TARGET = { kind: 'local' } as const
function state(): CodexMaintenanceState {
  const installation = codexCliInstallation(false, null)
  return {
    installation,
    action: codexMaintenanceAction(installation, false),
    canRun: true,
    job: null
  }
}
function running(): CodexMaintenanceState {
  const initial = state()
  if (!initial.action) {
    throw new Error('Missing action')
  }
  return {
    ...initial,
    job: {
      id: 'job',
      phase: 'running',
      action: initial.action,
      output: 'started',
      exitCode: null,
      error: null
    }
  }
}
beforeEach(() => {
  resetCodexMaintenanceStoreForTests()
  call.mockReset()
  refreshAgents.mockClear()
  vi.useFakeTimers()
})
afterEach(() => {
  resetCodexMaintenanceStoreForTests()
  vi.useRealTimers()
})
describe('shared Codex maintenance snapshots', () => {
  it('ignores an older status response after an explicit start', async () => {
    let completeStatus: (value: CodexMaintenanceState) => void = () => {}
    call.mockImplementationOnce(
      () =>
        new Promise<CodexMaintenanceState>((resolve) => {
          completeStatus = resolve
        })
    )
    const pending = refreshCodexMaintenance(TARGET)
    call.mockResolvedValueOnce(running())
    startCodexMaintenance(TARGET)
    await vi.advanceTimersByTimeAsync(0)
    completeStatus(state())
    await pending
    expect(getCodexMaintenanceEntry('local:codex').state?.job?.phase).toBe('running')
    expect(getCodexMaintenanceEntry('local:codex').starting).toBe(false)
  })

  it('keeps host-owned job evidence after contact loss and bounds read retries', async () => {
    call.mockResolvedValueOnce(running())
    startCodexMaintenance(TARGET)
    await vi.advanceTimersByTimeAsync(0)
    call.mockRejectedValue(new Error('Host disconnected'))
    await vi.advanceTimersByTimeAsync(5_000)
    const entry = getCodexMaintenanceEntry('local:codex')
    expect(entry.error).toBe('Host disconnected')
    expect(entry.state?.job?.phase).toBe('running')
    expect(entry.state?.job?.output).toBe('started')
    expect(call.mock.calls.filter(([, params]) => params.operation === 'start')).toHaveLength(1)
    expect(call.mock.calls.filter(([, params]) => params.operation === 'read')).toHaveLength(3)
    expect(refreshAgents).not.toHaveBeenCalled()
    await refreshCodexMaintenance(TARGET)
    expect(getCodexMaintenanceEntry('local:codex').state?.job?.id).toBe('job')
  })

  it('coalesces status requests without starting an install automatically', async () => {
    call.mockResolvedValue(state())
    await Promise.all([refreshCodexMaintenance(TARGET), refreshCodexMaintenance(TARGET)])
    expect(call).toHaveBeenCalledTimes(1)
    expect(call.mock.calls[0][1]).toEqual({ operation: 'status' })
  })
})
