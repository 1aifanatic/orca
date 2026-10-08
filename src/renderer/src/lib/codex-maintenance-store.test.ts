import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { codexCliInstallation } from '../../../shared/codex-cli-installation'
import {
  codexMaintenanceAction,
  type CodexMaintenanceState
} from '../../../shared/codex-cli-maintenance'
import {
  getCodexMaintenanceEntry,
  getCodexMaintenanceHostBusy,
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
  codexMaintenanceTargetKey: (target: { cwd?: string }) =>
    target.cwd ? `local:codex:${target.cwd}` : 'local:codex'
}))
vi.mock('@/store', () => ({
  useAppStore: {
    subscribe: () => () => {},
    getState: () => ({ refreshDetectedAgents: refreshAgents })
  }
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
  it('shares host job activity across workspace contexts while keeping their installation facts separate', async () => {
    const workspace = { kind: 'local', cwd: '/project' } as const
    call.mockResolvedValueOnce(state())
    await refreshCodexMaintenance(TARGET)
    call.mockResolvedValueOnce(running())
    startCodexMaintenance(workspace)
    expect(getCodexMaintenanceHostBusy(TARGET)).toBe(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(getCodexMaintenanceHostBusy(TARGET)).toBe(true)
    const completed = running()
    if (!completed.job) {
      throw new Error('No job')
    }
    completed.job.phase = 'completed'
    call.mockResolvedValueOnce(completed).mockResolvedValueOnce(state())
    await vi.advanceTimersByTimeAsync(1000)
    expect(getCodexMaintenanceHostBusy(TARGET)).toBe(false)
    expect(getCodexMaintenanceEntry('local:codex').state?.job).toBeNull()
  })

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

  it('cancels an error retry poll without stranding a slow explicit start', async () => {
    call.mockResolvedValueOnce(running())
    startCodexMaintenance(TARGET)
    await vi.advanceTimersByTimeAsync(0)
    call.mockRejectedValueOnce(new Error('Transient read failure'))
    await vi.advanceTimersByTimeAsync(1_000)
    let complete: (result: CodexMaintenanceState) => void = () => {}
    call.mockImplementationOnce(
      () =>
        new Promise<CodexMaintenanceState>((resolve) => {
          complete = resolve
        })
    )
    startCodexMaintenance(TARGET)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(call).toHaveBeenCalledTimes(3)
    const result = running()
    if (!result.job) {
      throw new Error('No job')
    }
    result.job.phase = 'completed'
    result.job.exitCode = 1
    complete(result)
    await vi.advanceTimersByTimeAsync(0)
    expect(getCodexMaintenanceEntry('local:codex').starting).toBe(false)
    call.mockResolvedValueOnce(state())
    await refreshCodexMaintenance(TARGET)
    expect(call).toHaveBeenCalledTimes(4)
    call.mockResolvedValueOnce(result)
    startCodexMaintenance(TARGET)
    await vi.advanceTimersByTimeAsync(0)
    expect(call).toHaveBeenCalledTimes(5)
  })

  it('withdraws stale installation facts while checking and after a failed read, retaining job evidence', async () => {
    call.mockResolvedValueOnce(running())
    await refreshCodexMaintenance(TARGET)
    let rejectRead: (error: Error) => void = () => {}
    call.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectRead = reject
        })
    )
    const pending = refreshCodexMaintenance(TARGET)
    expect(getCodexMaintenanceEntry('local:codex').verification).toBe('checking')
    rejectRead(new Error('Host unavailable'))
    await pending
    const entry = getCodexMaintenanceEntry('local:codex')
    expect(entry.verification).toBe('unverifiable')
    expect(entry.state?.job?.output).toBe('started')
    expect(entry.state?.installation.status).toBe('missing')
  })
})
