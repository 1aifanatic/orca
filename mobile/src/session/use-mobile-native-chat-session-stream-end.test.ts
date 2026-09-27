import { createElement, Fragment, type ReactElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import type { RpcClient } from '../transport/rpc-client'
import { MobileRelayRpcStreams } from '../transport/mobile-relay-rpc-streams'
import { RpcClientStreamRegistry } from '../transport/rpc-client-stream-registry'
import type { RpcResponse } from '../transport/types'
import {
  useMobileNativeChatSession,
  type MobileNativeChatSession
} from './use-mobile-native-chat-session'

function message(id: string): NativeChatMessage {
  return {
    id,
    role: 'assistant',
    blocks: [{ type: 'text', text: id }],
    timestamp: 1,
    source: 'transcript'
  }
}

function streamed(id: string, result: unknown): RpcResponse {
  return { id, ok: true, streaming: true, result, _meta: { runtimeId: 'runtime-1' } }
}

type SentRequest = { id: string; method: string; params?: unknown }

function readSentRequest(value: unknown): SentRequest {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('id' in value) ||
    !('method' in value) ||
    typeof value.id !== 'string' ||
    typeof value.method !== 'string'
  ) {
    throw new Error('unexpected request shape')
  }
  return {
    id: value.id,
    method: value.method,
    params: 'params' in value ? value.params : undefined
  }
}

function testClient(subscribe: RpcClient['subscribe']): RpcClient {
  return {
    sendRequest: () => new Promise<RpcResponse>(() => {}),
    subscribe,
    updateTerminalSubscriptionViewport: () => {},
    getState: () => 'connected',
    getReconnectAttempt: () => 0,
    getLastConnectedAt: () => null,
    onStateChange: () => () => {},
    notifyForeground: () => {},
    close: () => {}
  }
}

/** A client whose host is the test: every subscribe's listener is kept, in order. */
function listenerClient(): {
  client: RpcClient
  subscribe: ReturnType<typeof vi.fn<RpcClient['subscribe']>>
  listeners: ((frame: unknown) => void)[]
} {
  const listeners: ((frame: unknown) => void)[] = []
  const subscribe = vi.fn<RpcClient['subscribe']>((_method, _params, onData) => {
    listeners.push(onData)
    return () => {}
  })
  return { client: testClient(subscribe), subscribe, listeners }
}

/** A host that, like the runtime, keys each feed by its token: a same-token subscribe ends the feed
 *  it replaces, and an unsubscribe ends whatever holds the token. Frames queue until `deliver`, so
 *  each end lands a round trip after the request that caused it. */
function evictingHost(): {
  client: RpcClient
  subscribe: ReturnType<typeof vi.fn<RpcClient['subscribe']>>
  deliver: () => Promise<void>
} {
  const live = new Map<string, (frame: unknown) => void>()
  let queued: (() => void)[] = []
  const subscribe = vi.fn<RpcClient['subscribe']>((_method, params, onData) => {
    const token =
      typeof params === 'object' && params !== null && 'subscriptionId' in params
        ? String(params.subscriptionId)
        : ''
    const replaced = live.get(token)
    live.set(token, onData)
    if (replaced) {
      queued.push(() => replaced({ type: 'end' }))
    }
    queued.push(() => onData({ type: 'snapshot', messages: [message('a')], hasMore: false }))
    return () => {
      const holder = live.get(token)
      live.delete(token)
      if (holder && holder !== onData) {
        queued.push(() => holder({ type: 'end' }))
      }
    }
  })
  const deliver = async (): Promise<void> => {
    // Bounded so a ping-pong between screens shows up as extra subscribes, not a hang.
    for (let round = 0; round < 10 && queued.length > 0; round += 1) {
      const frames = queued
      queued = []
      await act(async () => {
        for (const frame of frames) {
          frame()
        }
      })
    }
  }
  return { client: testClient(subscribe), subscribe, deliver }
}

/** A paired host as the phone's real stream layer sees it: requests out, replies in. */
type TransportRig = {
  client: RpcClient
  sent: SentRequest[]
  reply: (response: RpcResponse) => void
  /** Drops and re-authenticates the socket; only the direct transport replays its streams. */
  reconnect?: () => void
}

function directRig(): TransportRig {
  const sent: SentRequest[] = []
  let nextId = 0
  const registry = new RpcClientStreamRegistry({
    nextId: () => `rpc-${++nextId}`,
    deviceToken: 'device-token',
    getState: () => 'connected',
    sendEncrypted: (request) => {
      sent.push(readSentRequest(request))
      return true
    }
  })
  return {
    client: testClient(registry.subscribe.bind(registry)),
    sent,
    reply: (response) => registry.handleResponse(response),
    reconnect: () => {
      registry.markForReplay()
      registry.replayAfterAuthentication()
    }
  }
}

function relayRig(): TransportRig {
  const sent: SentRequest[] = []
  let nextId = 0
  const streams = new MobileRelayRpcStreams({
    nextId: () => `relay-${++nextId}`,
    sendFrame: (request) => {
      sent.push(request)
      return true
    },
    waitForConnected: async () => {}
  })
  return {
    client: testClient(streams.subscribe.bind(streams)),
    sent,
    reply: (response) => streams.handleResponse(response)
  }
}

describe('useMobileNativeChatSession host-ended stream recovery', () => {
  let renderer: ReactTestRenderer | null = null
  let state: MobileNativeChatSession | null = null

  beforeEach(() => {
    state = null
    vi.useFakeTimers()
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    vi.useRealTimers()
  })

  function Harness({ client, sessionId }: { client: RpcClient; sessionId: string }): null {
    state = useMobileNativeChatSession({
      client,
      sourceIdentity: 'host-a\0workspace-a',
      agent: 'claude',
      sessionId,
      transcriptPath: null
    })
    return null
  }

  async function mount(client: RpcClient, sessionId = 'session'): Promise<void> {
    await act(async () => {
      renderer = create(createElement(Harness, { client, sessionId }))
    })
  }

  function chatSubscribes(rig: TransportRig): SentRequest[] {
    return rig.sent.filter((request) => request.method === 'nativeChat.subscribe')
  }

  it.each([
    ['direct', directRig],
    ['relay', relayRig]
  ])(
    'reopens a chat stream the host ended on a %s connection and is not live until its snapshot',
    async (_label, makeRig) => {
      const rig = makeRig()
      await mount(rig.client)
      const first = chatSubscribes(rig)[0]!
      await act(async () => {
        rig.reply(
          streamed(first.id, { type: 'snapshot', messages: [message('a')], hasMore: false })
        )
      })
      expect(state?.status).toBe('ready')

      // Another consumer on this connection replaced the host subscription.
      await act(async () => {
        rig.reply(streamed(first.id, { type: 'end' }))
      })

      const subscribes = chatSubscribes(rig)
      expect(subscribes).toHaveLength(2)
      expect(subscribes[1]!.params).toEqual({
        ...(first.params as object),
        subscriptionId: expect.stringMatching(/^claude:session:/)
      })
      expect(state?.status).toBe('loading')
      expect(state?.transcriptLoading).toBe(true)
      // The conversation stays on screen while the stream reopens.
      expect(state?.messages.map((entry) => entry.id)).toEqual(['a'])

      await act(async () => {
        rig.reply(
          streamed(subscribes[1]!.id, {
            type: 'snapshot',
            messages: [message('a'), message('b')],
            hasMore: false
          })
        )
      })
      expect(state?.status).toBe('ready')
      expect(state?.messages.map((entry) => entry.id)).toEqual(['a', 'b'])
    }
  )

  it('does not reopen for an end on a stream it cancelled or replaced itself', async () => {
    const { client, subscribe, listeners } = listenerClient()
    await mount(client)

    // Switching sessions cancels the first stream; its late end must not reopen anything.
    await act(async () => renderer?.update(createElement(Harness, { client, sessionId: 'other' })))
    expect(subscribe).toHaveBeenCalledTimes(2)
    await act(async () => listeners[0]!({ type: 'end' }))
    await act(async () => {
      vi.advanceTimersByTime(120_000)
    })
    expect(subscribe).toHaveBeenCalledTimes(2)

    // After its own reopen, a second end on the stream it already abandoned is inert.
    await act(async () => listeners[1]!({ type: 'end' }))
    expect(subscribe).toHaveBeenCalledTimes(3)
    await act(async () => listeners[1]!({ type: 'end' }))
    await act(async () => {
      vi.advanceTimersByTime(120_000)
    })
    expect(subscribe).toHaveBeenCalledTimes(3)

    // A duplicate end while the reopen is still backing off neither reopens twice nor
    // charges the backoff again: the next retry still waits 2s, not 4s.
    await act(async () => listeners[2]!({ type: 'end' }))
    await act(async () => listeners[2]!({ type: 'end' }))
    await act(async () => {
      vi.advanceTimersByTime(1_000)
    })
    expect(subscribe).toHaveBeenCalledTimes(4)
    await act(async () => listeners[3]!({ type: 'end' }))
    await act(async () => {
      vi.advanceTimersByTime(2_000)
    })
    expect(subscribe).toHaveBeenCalledTimes(5)
  })

  it('backs off repeated ends to a cap, even when each reopen delivers a snapshot', async () => {
    const { client, subscribe, listeners } = listenerClient()
    await mount(client)
    const endLatest = async (withSnapshot: boolean): Promise<void> => {
      const listener = listeners.at(-1)!
      await act(async () => {
        if (withSnapshot) {
          listener({ type: 'snapshot', messages: [message('a')], hasMore: false })
        }
        listener({ type: 'end' })
      })
    }

    await endLatest(true)
    expect(subscribe).toHaveBeenCalledTimes(2)

    // Two screens evicting each other: each reopen is live briefly, then ends again.
    const expectedDelays = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]
    for (const [index, delayMs] of expectedDelays.entries()) {
      await endLatest(index % 2 === 0)
      await act(async () => {
        vi.advanceTimersByTime(delayMs - 1)
      })
      expect(subscribe).toHaveBeenCalledTimes(index + 2)
      expect(state?.status).toBe('loading')
      await act(async () => {
        vi.advanceTimersByTime(1)
      })
      expect(subscribe).toHaveBeenCalledTimes(index + 3)
    }
  })

  it('is live again after the reopened snapshot and resets the backoff once that stream holds', async () => {
    const { client, subscribe, listeners } = listenerClient()
    await mount(client)
    await act(async () => listeners[0]!({ type: 'end' }))
    await act(async () => listeners[1]!({ type: 'end' }))
    await act(async () => {
      vi.advanceTimersByTime(1_000)
    })
    expect(subscribe).toHaveBeenCalledTimes(3)

    await act(async () =>
      listeners[2]!({ type: 'snapshot', messages: [message('a')], hasMore: false })
    )
    expect(state?.status).toBe('ready')
    await act(async () => {
      vi.advanceTimersByTime(60_000)
    })

    await act(async () => listeners[2]!({ type: 'end' }))
    expect(subscribe).toHaveBeenCalledTimes(4)
  })
})

describe('useMobileNativeChatSession feeds across stacked screens', () => {
  let renderer: ReactTestRenderer | null = null
  const states = new Map<string, MobileNativeChatSession>()

  beforeEach(() => {
    states.clear()
    vi.useFakeTimers()
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    vi.useRealTimers()
  })

  function Screen({ name, client }: { name: string; client: RpcClient }): null {
    states.set(
      name,
      useMobileNativeChatSession({
        client,
        sourceIdentity: 'host-a\0workspace-a',
        agent: 'claude',
        sessionId: 'session',
        transcriptPath: null
      })
    )
    return null
  }

  function Stack({ client, screens }: { client: RpcClient; screens: string[] }): ReactElement {
    return createElement(
      Fragment,
      null,
      ...screens.map((name) => createElement(Screen, { key: name, name, client }))
    )
  }

  async function render(client: RpcClient, screens: string[]): Promise<void> {
    await act(async () => {
      if (renderer) {
        renderer.update(createElement(Stack, { client, screens }))
      } else {
        renderer = create(createElement(Stack, { client, screens }))
      }
    })
  }

  function tokenOf(request: SentRequest | unknown[]): unknown {
    const params = Array.isArray(request) ? request[1] : request.params
    return typeof params === 'object' && params !== null && 'subscriptionId' in params
      ? params.subscriptionId
      : undefined
  }

  it('keeps both feeds live when a pushed screen opens the same chat, and after it pops', async () => {
    const host = evictingHost()
    await render(host.client, ['under'])
    await host.deliver()
    expect(states.get('under')?.status).toBe('ready')

    // Resuming from agent history pushes a second screen for the same chat.
    await render(host.client, ['under', 'top'])
    await host.deliver()
    for (let second = 0; second < 120; second += 1) {
      await act(async () => {
        vi.advanceTimersByTime(1_000)
      })
      await host.deliver()
      expect(states.get('under')?.status).toBe('ready')
      expect(states.get('top')?.status).toBe('ready')
    }
    expect(host.subscribe).toHaveBeenCalledTimes(2)
    const [under, top] = host.subscribe.mock.calls
    expect(tokenOf(under!)).not.toBe(tokenOf(top!))

    // Popping the pushed screen releases its own feed only.
    await render(host.client, ['under'])
    await host.deliver()
    await act(async () => {
      vi.advanceTimersByTime(120_000)
    })
    await host.deliver()
    expect(host.subscribe).toHaveBeenCalledTimes(2)
    expect(states.get('under')?.status).toBe('ready')
  })

  it.each([
    ['direct', directRig],
    ['relay', relayRig]
  ])(
    'names each %s chat feed by its own token on replay and unsubscribe',
    async (_label, makeRig) => {
      const rig = makeRig()
      await render(rig.client, ['under', 'top'])
      const [under, top] = rig.sent.filter((request) => request.method === 'nativeChat.subscribe')
      expect(tokenOf(under!)).toMatch(/^claude:session:/)
      expect(tokenOf(top!)).toMatch(/^claude:session:/)
      expect(tokenOf(under!)).not.toBe(tokenOf(top!))

      if (rig.reconnect) {
        rig.reconnect()
        const replayed = rig.sent
          .filter((request) => request.method === 'nativeChat.subscribe')
          .slice(2)
        expect(replayed.map((request) => [request.id, tokenOf(request)])).toEqual([
          [under!.id, tokenOf(under!)],
          [top!.id, tokenOf(top!)]
        ])
      }

      // The older screen leaves while the newer one stays: its unsubscribe must still be sent.
      await render(rig.client, ['top'])
      expect(
        rig.sent
          .filter((request) => request.method === 'nativeChat.unsubscribe')
          .map((request) => request.params)
      ).toEqual([{ subscriptionId: tokenOf(under!) }])
    }
  )
})

describe('useMobileNativeChatSession history across a recovery reopen', () => {
  let renderer: ReactTestRenderer | null = null
  let state: MobileNativeChatSession | null = null

  beforeEach(() => {
    state = null
    vi.useFakeTimers()
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    vi.useRealTimers()
  })

  function Harness({ client, sessionId }: { client: RpcClient; sessionId: string }): null {
    state = useMobileNativeChatSession({
      client,
      sourceIdentity: 'host-a\0workspace-a',
      agent: 'claude',
      sessionId,
      transcriptPath: null
    })
    return null
  }

  const window = Array.from({ length: 40 }, (_unused, index) => message(`win-${index}`))

  /** Mounts on a host holding 100 messages and pages the older 60 in. */
  async function mountWithPagedHistory(): Promise<{
    client: RpcClient
    subscribe: ReturnType<typeof vi.fn<RpcClient['subscribe']>>
    listeners: ((frame: unknown) => void)[]
  }> {
    const { client: base, subscribe, listeners } = listenerClient()
    const client: RpcClient = {
      ...base,
      sendRequest: vi.fn<RpcClient['sendRequest']>().mockResolvedValue({
        id: 'page',
        ok: true,
        result: {
          messages: Array.from({ length: 60 }, (_unused, index) => message(`paged-${index}`)),
          hasMore: false,
          beforeOffset: 40
        },
        _meta: { runtimeId: 'runtime-1' }
      })
    }
    await act(async () => {
      renderer = create(createElement(Harness, { client, sessionId: 'session' }))
    })
    await act(async () =>
      listeners[0]!({ type: 'snapshot', messages: window, hasMore: true, beforeOffset: 100 })
    )
    await act(async () => {
      state?.loadEarlier()
      await Promise.resolve()
    })
    expect(state?.messages).toHaveLength(100)
    return { client, subscribe, listeners }
  }

  it('reopens with the first-page window and keeps paged-in older history', async () => {
    const { subscribe, listeners } = await mountWithPagedHistory()

    await act(async () => listeners[0]!({ type: 'end' }))
    expect(subscribe).toHaveBeenCalledTimes(2)
    expect(subscribe.mock.calls[1]![1]).toMatchObject({ limit: 40 })
    expect(state?.messages).toHaveLength(100)
    expect(state?.messages[0]?.id).toBe('paged-0')

    // The reopened first page merges in as a replay, carrying one message that arrived meanwhile.
    await act(async () =>
      listeners[1]!({
        type: 'snapshot',
        messages: [...window.slice(1), message('live-1')],
        hasMore: true,
        beforeOffset: 100
      })
    )
    expect(state?.status).toBe('ready')
    expect(state?.messages).toHaveLength(100)
    expect(state?.messages[0]?.id).toBe('paged-1')
    expect(state?.messages.at(-1)?.id).toBe('live-1')
    expect(state?.hasMore).toBe(true)

    await act(async () => listeners[1]!({ type: 'appended', messages: [message('live-2')] }))
    expect(state?.messages).toHaveLength(100)
    expect(state?.messages.at(-1)?.id).toBe('live-2')
  })

  it('keeps every row of a disjoint reopened window when the next live message lands', async () => {
    const { listeners } = await mountWithPagedHistory()
    await act(async () => listeners[0]!({ type: 'end' }))

    const fresh = Array.from({ length: 100 }, (_unused, index) => message(`fresh-${index}`))
    await act(async () =>
      listeners[1]!({ type: 'snapshot', messages: fresh, hasMore: true, beforeOffset: 500 })
    )
    expect(state?.messages.map((entry) => entry.id)).toEqual(fresh.map((entry) => entry.id))

    await act(async () => listeners[1]!({ type: 'appended', messages: [message('live-1')] }))
    expect(state?.messages.length).toBeGreaterThanOrEqual(100)
    expect(state?.messages.at(-1)?.id).toBe('live-1')
  })

  it('still resets to a fresh window when the chat changes while a reopen is pending', async () => {
    const { client, subscribe, listeners } = await mountWithPagedHistory()
    await act(async () => listeners[0]!({ type: 'end' }))
    // A second end waits out the backoff, leaving the reopen pending.
    await act(async () => listeners[1]!({ type: 'end' }))
    expect(subscribe).toHaveBeenCalledTimes(2)

    await act(async () => renderer?.update(createElement(Harness, { client, sessionId: 'other' })))
    expect(subscribe).toHaveBeenCalledTimes(3)
    expect(subscribe.mock.calls[2]![1]).toMatchObject({ sessionId: 'other', limit: 40 })
    expect(state?.messages).toEqual([])
    await act(async () => listeners[2]!({ type: 'snapshot', messages: [message('x')] }))
    expect(state?.messages.map((entry) => entry.id)).toEqual(['x'])

    await act(async () => {
      vi.advanceTimersByTime(120_000)
    })
    expect(subscribe).toHaveBeenCalledTimes(3)
  })
})
