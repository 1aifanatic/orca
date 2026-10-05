import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import type {
  NativeChatMessage,
  NativeChatTurnLifecycle
} from '../../../../shared/native-chat-types'
import type { SubscribeNativeChatTranscriptArgs } from '../../../native-chat/transcript-watch-contract'
import { buildRegistry, isStreamingMethod, type RpcContext } from '../core'
import { createDispatcherStreamingFeatureEmitter } from '../dispatcher-streaming-feature-emitter'
import { mobileE2EETextPayloadAdmissionBytes } from '../mobile-e2ee-outbound-admission'
import { createSubscriptionRegistryDouble } from '../subscription-registry-test-double'

type MockState = {
  watcher: SubscribeNativeChatTranscriptArgs | null
  setup: Promise<{ watching: boolean; unsubscribe: () => void }> | null
  unsubscribe: Mock<() => void>
  tailLifecycle: NativeChatTurnLifecycle | undefined
}
const state = vi.hoisted((): MockState => ({
  watcher: null,
  setup: null,
  unsubscribe: vi.fn<() => void>(),
  tailLifecycle: undefined
}))
vi.mock('../../../managed-data-accounts/service', () => ({ getManagedDataAccountService: vi.fn() }))
vi.mock('../../../native-chat/transcript-watch', () => ({
  readNativeChatTranscriptTail: async () => ({
    messages: [message('m-1', 0)],
    hasMore: false,
    beforeOffset: 0,
    ...(state.tailLifecycle ? { lifecycle: state.tailLifecycle } : {})
  }),
  subscribeNativeChatTranscript: (args: SubscribeNativeChatTranscriptArgs) => {
    state.watcher = args
    return state.setup ?? Promise.resolve({ watching: true, unsubscribe: state.unsubscribe })
  }
}))
import { NATIVE_CHAT_METHODS } from './native-chat'
import { NATIVE_CHAT_FRAME_TOO_LARGE_ERROR } from './native-chat-rpc-envelope-admission'

afterEach(() => {
  state.watcher = null
  state.setup = null
  state.unsubscribe = vi.fn<() => void>()
  state.tailLifecycle = undefined
})

// Over the phone socket's 4 MiB JSON cap on its own.
const HUGE = 'x'.repeat(4.5 * 1024 * 1024)
const hugeLifecycle: NativeChatTurnLifecycle = { state: 'completed', turnId: HUGE, timestamp: 1 }

function message(id: string, offset: number): NativeChatMessage {
  return {
    id,
    role: 'assistant',
    source: 'transcript',
    timestamp: 1,
    transcriptOffset: offset,
    blocks: [{ type: 'text', text: id }]
  }
}

async function subscribe(clientKind: RpcContext['clientKind'] = 'mobile') {
  const method = buildRegistry(NATIVE_CHAT_METHODS).get('nativeChat.subscribe')!
  if (!isStreamingMethod(method)) {
    throw new Error('Expected a subscription')
  }
  const registry = createSubscriptionRegistryDouble()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: native chat only uses the subscription registry methods the double implements.
  const runtime = registry as unknown as RpcContext['runtime']
  const replies: string[] = []
  const emitter = createDispatcherStreamingFeatureEmitter(
    runtime,
    { id: 'chat-stream', authToken: 'fixture', method: 'nativeChat.subscribe' },
    { runtimeId: '00000000-0000-4000-8000-000000000000' },
    (reply) => replies.push(reply)
  )
  const ctx: RpcContext = {
    runtime,
    clientKind,
    connectionId: 'phone',
    requestId: 'chat-stream'
  }
  const setup = method.handler(
    method.params?.parse({ agent: 'claude', sessionId: 'session', subscriptionId: 'token' }),
    ctx,
    emitter.emit
  )
  return {
    setup,
    replies,
    results: () =>
      replies.map((reply) => {
        const response: { result: unknown } = JSON.parse(reply)
        return response.result
      }),
    registered: () => registry.peekCleanup('nativeChat:phone:token') !== undefined
  }
}

function watcher(): SubscribeNativeChatTranscriptArgs {
  if (!state.watcher) {
    throw new Error('Expected a transcript watcher')
  }
  return state.watcher
}

function expectAdmitted(replies: readonly string[]): void {
  for (const reply of replies) {
    expect(Number.isFinite(mobileE2EETextPayloadAdmissionBytes(reply))).toBe(true)
  }
}

describe('native-chat mobile envelope admission', () => {
  it('drops an oversized lifecycle from a snapshot, replacement and lifecycle-only append', async () => {
    const stream = await subscribe()
    await stream.setup

    watcher().onInitialSnapshot?.([message('m-1', 0)], false, 0, undefined, hugeLifecycle)
    watcher().onReplace?.([message('m-2', 10)], false, 10, hugeLifecycle)
    watcher().onAppend([], hugeLifecycle)

    expectAdmitted(stream.replies)
    expect(stream.results()).toEqual([
      { type: 'snapshot', messages: [message('m-1', 0)], hasMore: false, beforeOffset: 0 },
      { type: 'replacement', messages: [message('m-2', 10)], hasMore: false, beforeOffset: 10 },
      { type: 'appended', messages: [] }
    ])
    expect(stream.registered()).toBe(true)
  })

  it('keeps a lifecycle that fits', async () => {
    const stream = await subscribe()
    await stream.setup
    const lifecycle: NativeChatTurnLifecycle = { state: 'working', turnId: 't', timestamp: 1 }

    watcher().onAppend([message('m-1', 0)], lifecycle)

    expect(stream.results()).toEqual([
      { type: 'appended', messages: [message('m-1', 0)], lifecycle }
    ])
  })

  it('drops an oversized lifecycle from a readSession reply', async () => {
    state.tailLifecycle = hugeLifecycle
    const method = buildRegistry(NATIVE_CHAT_METHODS).get('nativeChat.readSession')!
    if (isStreamingMethod(method)) {
      throw new Error('Expected a page read')
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: readSession never touches the runtime.
    const runtime = {} as RpcContext['runtime']

    const result = await method.handler(
      method.params?.parse({ agent: 'claude', sessionId: 'session' }),
      { runtime, clientKind: 'mobile', requestId: 'read' }
    )

    expect(result).toEqual({ messages: [message('m-1', 0)], hasMore: false, beforeOffset: 0 })
  })

  it('ends only this stream, once, when a frame cannot fit even without its lifecycle', async () => {
    const stream = await subscribe()
    await stream.setup

    watcher().onInitialSnapshot?.([message('m-1', 0)], false, 0, HUGE, hugeLifecycle)
    watcher().onAppend([message('m-2', 10)])
    watcher().onReplace?.([message('m-3', 20)], false, 20)

    expectAdmitted(stream.replies)
    expect(stream.results()).toEqual([{ type: 'end', error: NATIVE_CHAT_FRAME_TOO_LARGE_ERROR }])
    expect(state.unsubscribe).toHaveBeenCalledTimes(1)
    // The registry retires an entry once its cleanup settles, as the runtime does.
    await vi.waitFor(() => expect(stream.registered()).toBe(false))
  })

  it('releases the watcher when the overflow lands while transcript setup is still pending', async () => {
    const setup = Promise.withResolvers<{ watching: boolean; unsubscribe: () => void }>()
    state.setup = setup.promise
    const stream = await subscribe()
    await vi.waitFor(() => expect(state.watcher).not.toBeNull())

    watcher().onInitialSnapshot?.([], false, 0, HUGE)
    setup.resolve({ watching: true, unsubscribe: state.unsubscribe })
    await stream.setup

    expect(stream.results()).toEqual([{ type: 'end', error: NATIVE_CHAT_FRAME_TOO_LARGE_ERROR }])
    expect(state.unsubscribe).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(stream.registered()).toBe(false))
  })

  it('leaves paired desktop frames unadmitted, as before', async () => {
    const stream = await subscribe('runtime')
    await stream.setup

    watcher().onAppend([], hugeLifecycle)

    expect(stream.results()).toEqual([{ type: 'appended', messages: [], lifecycle: hugeLifecycle }])
  })
})
