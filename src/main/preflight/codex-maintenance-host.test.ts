import { afterEach, describe, expect, it, vi } from 'vitest'
import { codexCliInstallation } from '../../shared/codex-cli-installation'
import {
  codexMaintenanceAction,
  type CodexMaintenanceState
} from '../../shared/codex-cli-maintenance'
import { codexMaintenanceOnHost } from './codex-maintenance-host'

const { getMux, start, status } = vi.hoisted(() => ({
  getMux: vi.fn(),
  start: vi.fn(),
  status: vi.fn()
}))
vi.mock('../ssh/ssh-target-registry', () => ({ getActiveMultiplexer: getMux }))
vi.mock('./codex-maintenance-runner', () => ({ codexMaintenanceRunner: { start, status } }))
afterEach(() => vi.clearAllMocks())

function state(): CodexMaintenanceState {
  const installation = codexCliInstallation(false, null)
  return {
    installation,
    action: codexMaintenanceAction(installation, false),
    canRun: true,
    job: null
  }
}

describe('Codex maintenance execution host routing', () => {
  it('routes local status and explicit start to the same host owner', async () => {
    start.mockResolvedValue(state())
    status.mockResolvedValue(state())
    await codexMaintenanceOnHost({ operation: 'status' })
    await codexMaintenanceOnHost({ operation: 'start' })
    expect(start).toHaveBeenCalledOnce()
    expect(status).toHaveBeenCalledOnce()
  })
  it('negotiates SSH support before starting, then reads the relay job without local execution', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ agents: [], codexMaintenance: true })
      .mockResolvedValue(state())
    getMux.mockReturnValue({ isDisposed: () => false, request })
    expect(await codexMaintenanceOnHost({ connectionId: 'host-a', operation: 'start' })).toEqual(
      state()
    )
    await codexMaintenanceOnHost({ connectionId: 'host-a', operation: 'read', jobId: 'host-job' })
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      'preflight.detectAgents',
      'preflight.codexMaintenance',
      'preflight.codexMaintenance'
    ])
    expect(request).toHaveBeenLastCalledWith('preflight.codexMaintenance', {
      operation: 'read',
      jobId: 'host-job'
    })
    expect(start).not.toHaveBeenCalled()
  })
  it.each([{ agents: [] }, { agents: ['codex'], versions: { codex: '0.135.0' } }])(
    'shows command text on a relay without support: %j',
    async (legacy) => {
      const request = vi.fn().mockResolvedValue(legacy)
      getMux.mockReturnValue({ isDisposed: () => false, request })
      const result = await codexMaintenanceOnHost({ connectionId: 'old', operation: 'status' })
      expect(result.canRun).toBe(false)
      expect(result.action?.command).toBe('npm install -g @openai/codex')
      await expect(
        codexMaintenanceOnHost({ connectionId: 'old', operation: 'start' })
      ).rejects.toThrow('does not support')
      expect(request.mock.calls.every(([method]) => method === 'preflight.detectAgents')).toBe(true)
    }
  )
  it('isolates relay capabilities by connection and never substitutes local execution after contact loss', async () => {
    const a = {
      isDisposed: () => false,
      request: vi
        .fn()
        .mockResolvedValueOnce({ agents: [], codexMaintenance: true })
        .mockResolvedValue(state())
    }
    const b = { isDisposed: () => false, request: vi.fn().mockResolvedValue({ agents: ['codex'] }) }
    getMux.mockImplementation((id) => (id === 'a' ? a : b))
    await codexMaintenanceOnHost({ connectionId: 'a', operation: 'status' })
    expect(
      (await codexMaintenanceOnHost({ connectionId: 'b', operation: 'status' })).installation.status
    ).toBe('unknown')
    a.request.mockRejectedValue(new Error('connection lost'))
    await expect(
      codexMaintenanceOnHost({ connectionId: 'a', operation: 'read', jobId: 'job' })
    ).rejects.toThrow('connection lost')
    expect(start).not.toHaveBeenCalled()
  })
})
