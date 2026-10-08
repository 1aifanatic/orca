import { afterEach, describe, expect, it, vi } from 'vitest'
import { RelayDispatcher } from './dispatcher'
import { PreflightHandler } from './preflight-handler'
const { start, status } = vi.hoisted(() => ({
  start: vi.fn().mockResolvedValue({}),
  status: vi.fn().mockResolvedValue({})
}))
vi.mock('../main/preflight/codex-maintenance-runner', () => ({
  codexMaintenanceRunner: { start, status }
}))
const dispatchers: RelayDispatcher[] = []
afterEach(() => {
  for (const dispatcher of dispatchers.splice(0)) {
    dispatcher.dispose()
  }
  vi.clearAllMocks()
})
describe('relay Codex maintenance method', () => {
  it('registers and routes start and job reads on the relay execution host', async () => {
    const dispatcher = new RelayDispatcher(() => {})
    dispatchers.push(dispatcher)
    const registered = vi.spyOn(dispatcher, 'onRequest')
    new PreflightHandler(dispatcher)
    const handler = registered.mock.calls.find(
      ([name]) => name === 'preflight.codexMaintenance'
    )?.[1]
    if (!handler) {
      throw new Error('No maintenance handler')
    }
    const context = { clientId: 1, isStale: () => false }
    await handler({ operation: 'start' }, context)
    await handler({ operation: 'read', jobId: 'remote-job' }, context)
    expect(start).toHaveBeenCalledOnce()
    expect(status).toHaveBeenCalledWith('remote-job')
  })
  it('advertises support only to a client explicitly asking for it', async () => {
    const dispatcher = new RelayDispatcher(() => {})
    dispatchers.push(dispatcher)
    const registered = vi.spyOn(dispatcher, 'onRequest')
    new PreflightHandler(dispatcher)
    const handler = registered.mock.calls.find(([name]) => name === 'preflight.detectAgents')?.[1]
    if (!handler) {
      throw new Error('No detection handler')
    }
    const context = { clientId: 1, isStale: () => false }
    expect(await handler({ commands: [] }, context)).toEqual({ agents: [] })
    expect(await handler({ commands: [], reportCodexMaintenance: true }, context)).toEqual({
      agents: [],
      codexMaintenance: true
    })
  })
})
