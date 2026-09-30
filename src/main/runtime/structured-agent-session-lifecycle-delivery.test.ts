import { afterEach, describe, expect, it, vi } from 'vitest'
import { traceAgentSessionError } from '../observability/agent-session-error-trace'
import { createStructuredAgentSessionLifecycleDelivery } from './structured-agent-session-lifecycle-delivery'

vi.mock('../observability/agent-session-error-trace', () => ({
  traceAgentSessionError: vi.fn()
}))

const EXIT = {
  type: 'ended',
  sessionId: 'session-1',
  reason: 'provider crashed',
  cause: 'unexpected-exit',
  fence: 1,
  acquisitionGeneration: 'generation-1'
} as const

afterEach(() => {
  vi.mocked(traceAgentSessionError).mockClear()
})

describe('structured agent-session lifecycle delivery', () => {
  // No installer supplies a sink any more, so a failed exit recovery must still reach the trace.
  it('reports a failed recovery with its session and keeps the chain moving', async () => {
    const failure = new Error('journal write failed')
    const handle = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(undefined)
    const delivery = createStructuredAgentSessionLifecycleDelivery({
      handle,
      drainObservedExits: async () => undefined
    })

    delivery.deliver(EXIT)
    delivery.deliver({ ...EXIT, sessionId: 'session-2' })
    await delivery.drain()

    expect(handle).toHaveBeenCalledTimes(2)
    expect(traceAgentSessionError).toHaveBeenCalledExactlyOnceWith({
      step: 'provider-exit-settlement',
      sessionId: 'session-1',
      error: failure
    })
  })

  it('reports a failed start settlement under its own step', async () => {
    const failure = new Error('options write failed')
    const delivery = createStructuredAgentSessionLifecycleDelivery({
      handle: vi.fn().mockRejectedValue(failure),
      drainObservedExits: async () => undefined
    })

    delivery.deliver({
      type: 'started',
      sessionId: 'session-1',
      fence: 1,
      acquisitionGeneration: 'generation-1',
      reportedOptions: { model: 'model-1' },
      restoreSkippedOptions: []
    })
    await delivery.drain()

    expect(traceAgentSessionError).toHaveBeenCalledExactlyOnceWith({
      step: 'provider-started-settlement',
      sessionId: 'session-1',
      error: failure
    })
  })
})
