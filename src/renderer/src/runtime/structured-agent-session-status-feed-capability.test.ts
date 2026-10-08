// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { AgentSessionStatusEvent } from '../../../shared/agent-session-wire'
import {
  AGENT_SESSION_STATUS_FEED_RUNTIME_CAPABILITY,
  MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
  RUNTIME_PROTOCOL_VERSION
} from '../../../shared/protocol-version'

const transport = vi.hoisted(() => ({ call: vi.fn(), subscribe: vi.fn() }))
vi.mock('./structured-agent-session-client', () => ({
  subscribeStructuredAgentSessionStatus: transport.subscribe
}))

import {
  clearRecentRuntimeCompatibilityFailure,
  clearRuntimeCompatibilityCacheForTests
} from './runtime-rpc-client'
import {
  getStructuredAgentSessionStatusFeed,
  resetStructuredAgentSessionStatusFeedsForTests
} from './structured-agent-session-status-feed'

const REMOTE = { kind: 'environment', environmentId: 'server-1' } as const
const previousApi = Object.getOwnPropertyDescriptor(window, 'api')
const initial = useAppStore.getInitialState()
const subscriptions: {
  emit: (event: AgentSessionStatusEvent) => void
  unsubscribe: ReturnType<typeof vi.fn>
}[] = []

function reply(supported: boolean) {
  return {
    id: 'reply',
    ok: true,
    result: {
      runtimeId: 'remote',
      graphStatus: 'ready',
      runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
      minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
      capabilities: supported ? [AGENT_SESSION_STATUS_FEED_RUNTIME_CAPABILITY] : []
    },
    _meta: { runtimeId: 'remote' }
  }
}
function contact(epoch: number, generation = 0): void {
  useAppStore.setState({
    runtimeStatusByEnvironmentId: new Map([
      [
        'server-1',
        {
          status: null,
          checkedAt: epoch,
          hostContactEpoch: epoch,
          connectionGeneration: generation
        }
      ]
    ])
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  resetStructuredAgentSessionStatusFeedsForTests()
  clearRuntimeCompatibilityCacheForTests()
  useAppStore.setState({ runtimeStatusByEnvironmentId: new Map() })
  subscriptions.length = 0
  transport.call.mockReset().mockResolvedValue(reply(true))
  transport.subscribe.mockReset().mockImplementation(async (_target, emit) => {
    const subscription = { emit, unsubscribe: vi.fn() }
    subscriptions.push(subscription)
    return subscription
  })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      ...window.api,
      runtimeEnvironments: { call: transport.call }
    }
  })
})
afterEach(() => {
  resetStructuredAgentSessionStatusFeedsForTests()
  clearRuntimeCompatibilityCacheForTests()
  useAppStore.setState(initial, true)
  vi.restoreAllMocks()
  vi.useRealTimers()
  if (previousApi) {
    Object.defineProperty(window, 'api', previousApi)
  } else {
    Reflect.deleteProperty(window, 'api')
  }
})

it('notifies scalar readers of confirmed unsupported capability even with an unchanged empty snapshot', async () => {
  transport.call.mockResolvedValue(reply(false))
  const feed = getStructuredAgentSessionStatusFeed(REMOTE)
  const snapshot = feed.getSnapshot()
  const listener = vi.fn()
  const stopListener = feed.subscribe(listener)
  const stop = feed.activate()
  expect(feed.getCapability()).toBe('unknown')
  await vi.advanceTimersByTimeAsync(0)
  expect(feed.getCapability()).toBe('unsupported')
  expect(feed.getSnapshot()).toBe(snapshot)
  expect(feed.getSessionObservation('root')).toBe('unverifiable')
  expect(listener).toHaveBeenCalledOnce()
  expect(transport.call).toHaveBeenCalledOnce()
  expect(transport.subscribe).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
  stopListener()
  stop()
  expect(feed.getCapability()).toBe('unknown')
  feed.activate()
  await vi.advanceTimersByTimeAsync(0)
  expect(listener).toHaveBeenCalledOnce()
})

it('keeps failed probes unverifiable and retries without recording an unsupported verdict', async () => {
  transport.call.mockRejectedValueOnce(new Error('host unreachable'))
  const feed = getStructuredAgentSessionStatusFeed(REMOTE)
  const stop = feed.activate()
  await vi.advanceTimersByTimeAsync(0)
  expect(feed.getCapability()).toBe('unknown')
  expect(feed.getSessionObservation('root')).toBe('unverifiable')
  expect(transport.subscribe).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(250)
  expect(feed.getCapability()).toBe('supported')
  expect(transport.subscribe).toHaveBeenCalledOnce()
  stop()
  expect(subscriptions[0]?.unsubscribe).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
})

it('re-probes an unsupported host on a new activation using the real capability cache', async () => {
  transport.call.mockResolvedValueOnce(reply(false))
  const feed = getStructuredAgentSessionStatusFeed(REMOTE)
  const stop = feed.activate()
  await vi.advanceTimersByTimeAsync(0)
  expect(feed.getCapability()).toBe('unsupported')
  stop()
  feed.activate()
  expect(feed.getCapability()).toBe('unknown')
  await vi.advanceTimersByTimeAsync(0)
  expect(transport.call).toHaveBeenCalledTimes(2)
  expect(feed.getCapability()).toBe('supported')
  expect(transport.subscribe).toHaveBeenCalledOnce()
})

it('re-probes after host contact or generation changes and removes the shared contact listener on teardown', async () => {
  const originalSubscribe = useAppStore.subscribe
  const stopContact = vi.fn()
  vi.spyOn(useAppStore, 'subscribe').mockImplementation((listener) => {
    const stop = originalSubscribe(listener)
    return () => {
      stopContact()
      stop()
    }
  })
  transport.call.mockResolvedValueOnce(reply(false))
  const feed = getStructuredAgentSessionStatusFeed(REMOTE)
  const stop = feed.activate()
  await vi.advanceTimersByTimeAsync(0)
  expect(feed.getCapability()).toBe('unsupported')
  contact(1)
  expect(feed.getCapability()).toBe('unknown')
  contact(1, 1)
  expect(vi.getTimerCount()).toBe(1)
  await vi.advanceTimersByTimeAsync(500)
  expect(feed.getCapability()).toBe('supported')
  expect(transport.call).toHaveBeenCalledTimes(2)
  expect(transport.subscribe).toHaveBeenCalledOnce()
  stop()
  expect(stopContact).toHaveBeenCalledOnce()
  contact(2, 2)
  await vi.advanceTimersByTimeAsync(1_000)
  expect(feed.getCapability()).toBe('unknown')
  expect(transport.call).toHaveBeenCalledTimes(2)
  expect(vi.getTimerCount()).toBe(0)
})

it('fences an old unsupported reply across teardown and a newer supported activation', async () => {
  let release!: (value: ReturnType<typeof reply>) => void
  transport.call.mockReturnValueOnce(
    new Promise((resolve) => {
      release = resolve
    })
  )
  const feed = getStructuredAgentSessionStatusFeed(REMOTE)
  const stop = feed.activate()
  stop()
  // Runtime contact recovery discards the predecessor's pending compatibility proof.
  clearRecentRuntimeCompatibilityFailure('server-1')
  feed.activate()
  await vi.advanceTimersByTimeAsync(0)
  expect(feed.getCapability()).toBe('supported')
  release(reply(false))
  await vi.advanceTimersByTimeAsync(0)
  expect(transport.call).toHaveBeenCalledTimes(2)
  expect(feed.getCapability()).toBe('supported')
  expect(transport.subscribe).toHaveBeenCalledOnce()
})

it('never revives a stopped owner from a late capability reply or late stream handle', async () => {
  let release!: (value: ReturnType<typeof reply>) => void
  transport.call.mockReturnValueOnce(
    new Promise((resolve) => {
      release = resolve
    })
  )
  const feed = getStructuredAgentSessionStatusFeed(REMOTE)
  const stop = feed.activate()
  stop()
  release(reply(false))
  await vi.advanceTimersByTimeAsync(0)
  expect(feed.getCapability()).toBe('unknown')
  expect(transport.subscribe).not.toHaveBeenCalled()

  let opened!: (value: { unsubscribe: ReturnType<typeof vi.fn> }) => void
  const unsubscribe = vi.fn()
  transport.subscribe.mockReturnValueOnce(
    new Promise((resolve) => {
      opened = resolve
    })
  )
  const stopAgain = feed.activate()
  await vi.advanceTimersByTimeAsync(0)
  stopAgain()
  opened({ unsubscribe })
  await vi.advanceTimersByTimeAsync(0)
  expect(unsubscribe).toHaveBeenCalledOnce()
  expect(feed.getCapability()).toBe('unknown')
  expect(vi.getTimerCount()).toBe(0)
})

it('drops supported capability and live confirmation on disconnect, retaining no unsupported claim', async () => {
  const feed = getStructuredAgentSessionStatusFeed(REMOTE)
  feed.activate()
  await vi.advanceTimersByTimeAsync(0)
  subscriptions[0]?.emit({
    type: 'status',
    session: {
      sessionId: 'root',
      workspaceId: 'workspace',
      agent: 'claude',
      status: null,
      latestPrompt: '',
      updatedAt: 1
    }
  })
  expect(feed.getSessionObservation('root')).toBe('live')
  subscriptions[0]?.emit({ type: 'end' })
  expect(feed.getCapability()).toBe('unknown')
  expect(feed.getSessionObservation('root')).toBe('unverifiable')
})
