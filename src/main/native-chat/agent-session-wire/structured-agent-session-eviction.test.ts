import { describe, expect, it, vi } from 'vitest'
import {
  evictStructuredAgentSession,
  StructuredAgentSessionEvictionError,
  STRUCTURED_AGENT_SESSION_EVICTION_STEPS,
  type StructuredAgentSessionEvictionContext
} from './structured-agent-session-eviction'
import { StructuredAgentSessionHostRuntimeState } from './structured-agent-session-host-runtime-state'
import { createStructuredAgentSessionLogger } from './structured-agent-session-logger'
import { recordingStructuredAgentSessionLogger } from './structured-agent-session-logger-test-support'

function context(): StructuredAgentSessionEvictionContext & { order: string[] } {
  const order: string[] = []
  return {
    order,
    sessionId: 'session-1',
    logger: createStructuredAgentSessionLogger(),
    eventSink: {
      unbind: vi.fn(() => order.push('unbind')),
      drained: vi.fn(async () => {
        order.push('drained')
        return { ok: true }
      }),
      close: vi.fn(() => order.push('close'))
    } as unknown as StructuredAgentSessionEvictionContext['eventSink'],
    acknowledgeRelease: vi.fn(() => {
      order.push('acknowledgeRelease')
    }),
    discardSink: vi.fn(() => order.push('discardSink')),
    settleWork: vi.fn(async () => {
      order.push('settleWork')
    }),
    releaseLease: vi.fn(async () => {
      order.push('releaseLease')
    })
  }
}

function runtimeState(): StructuredAgentSessionHostRuntimeState {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: eviction against the sink cache reads only the sinks and the logger; store and adapter are never reached.
  return new StructuredAgentSessionHostRuntimeState({
    store: {},
    adapter: {},
    logger: recordingStructuredAgentSessionLogger().logger
  } as never)
}

describe('the wind-down after a proven exit', () => {
  it('drains what the child said before it lets the sink go, then acknowledges the release', async () => {
    const ctx = context()
    await evictStructuredAgentSession(ctx)
    expect(ctx.order).toEqual([
      'drained',
      'settleWork',
      'unbind',
      'close',
      'discardSink',
      'releaseLease',
      'acknowledgeRelease'
    ])
  })

  it('names every step, so a failure says which one it was', () => {
    expect(STRUCTURED_AGENT_SESSION_EVICTION_STEPS.map((step) => step.name)).toEqual([
      'drain-published',
      'settle-dead-generation',
      'stop-publishing',
      'close-sink',
      'discard-sink',
      'release-lease',
      'acknowledge-release'
    ])
  })

  // Bookkeeping for a process already gone: none of it may keep the child on record.
  it('reports a failed step with its name and still runs every step after it', async () => {
    const recorded = recordingStructuredAgentSessionLogger()
    const ctx = { ...context(), logger: recorded.logger }
    ctx.eventSink.drained = vi.fn(async () => {
      ctx.order.push('drained')
      return { ok: false, error: new Error('append failed') }
    }) as unknown as StructuredAgentSessionEvictionContext['eventSink']['drained']
    ctx.releaseLease = vi.fn(async () => {
      ctx.order.push('releaseLease')
      throw new Error('store unavailable')
    })

    await expect(evictStructuredAgentSession(ctx)).resolves.toBeUndefined()

    expect(ctx.order).toEqual([
      'drained',
      'settleWork',
      'unbind',
      'close',
      'discardSink',
      'releaseLease',
      'acknowledgeRelease'
    ])
    expect(recorded.entries.map((entry) => entry.fields.error)).toEqual([
      expect.objectContaining({ step: 'drain-published' }),
      expect.objectContaining({ step: 'release-lease' })
    ])
    expect(recorded.entries[0]?.fields.error).toBeInstanceOf(StructuredAgentSessionEvictionError)
  })
})

// The runtime caches ONE sink per session id and hands the same instance to the next attach, so an
// eviction that closes without discarding leaves a reopened chat wired to a permanently closed
// sink — it accepts every provider event and publishes none.
describe('eviction against the real sink cache', () => {
  it('lets the session publish again after it is evicted and reattached', async () => {
    const state = runtimeState()
    const sessionId = 'session-reattach'
    await evictStructuredAgentSession({
      sessionId,
      logger: recordingStructuredAgentSessionLogger().logger,
      eventSink: state.eventSinkFor(sessionId),
      discardSink: () => state.discardEventSink(sessionId),
      settleWork: async () => {},
      releaseLease: async () => {},
      acknowledgeRelease: () => {}
    })

    const published: string[] = []
    const reattached = state.eventSinkFor(sessionId)
    reattached.bind({ journal: {} as never, fence: 2, publish: () => published.push('published') })
    reattached.sink.publish()
    await reattached.drained()

    expect(published).toEqual(['published'])
  })
})
