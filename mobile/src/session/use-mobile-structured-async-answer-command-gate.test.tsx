// An async answer through the real structured send seam: the bridge's `answer` over the
// session's own `sendWithOutcome`, whose command gate is live here (only RPC is stubbed).
import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionSubscribeEvent } from '../../../src/shared/agent-session-wire'
import { formatAsyncQuestionReply } from '../../../src/shared/native-chat-async-questions'
import type { RpcClient } from '../transport/rpc-client'
import { resetMobileStructuredSendOperationJournalForTests } from './mobile-structured-send-operation-journal'
import { structuredSendResultFixture } from './structured-agent-send-result.test-fixture'
import type { MobileNativeChatSendOrigin } from './use-mobile-native-chat-drafts'
import { useMobileStructuredAgentSession } from './use-mobile-structured-agent-session'
import { useMobileStructuredNativeChatSendBridge } from './use-mobile-structured-native-chat-send-bridge'

const asyncStorage = vi.hoisted(() => ({
  getItem: vi.fn(),
  setItem: vi.fn(),
  removeItem: vi.fn()
}))

vi.mock('@react-native-async-storage/async-storage', () => ({ default: asyncStorage }))

const COMMAND_OR_MESSAGE_METHODS = new Set([
  'agentSession.send',
  'agentSession.conversationCommand',
  'agentSession.setOption'
])

const ORIGIN: MobileNativeChatSendOrigin = {
  draftKey: 'draft',
  draftEditGeneration: 0,
  pendingKey: 'pending',
  normalizedText: 'answer',
  baselineOccurrences: 0,
  baselineTailMessageId: null,
  baselineResolved: true
}

function ok(result: unknown) {
  return { ok: true, result, _meta: { runtimeId: 'runtime-1' } }
}

function snapshotEvent(): AgentSessionSubscribeEvent {
  return {
    type: 'snapshot',
    sessionId: 'session-1',
    fence: 3,
    page: {
      sessionId: 'session-1',
      epoch: 'epoch-1',
      fence: 3,
      direction: 'tail',
      items: [],
      removedItemIds: [],
      submissions: [],
      window: { oldest: null, newest: null, nextCursor: { epoch: 'epoch-1', sequence: 0 } },
      liveCursor: { epoch: 'epoch-1', sequence: 0 },
      hasOlder: false,
      hasNewer: false
    }
  }
}

describe('structured async answer through the real command gate', () => {
  let renderer: ReactTestRenderer | null = null
  let bridge: ReturnType<typeof useMobileStructuredNativeChatSendBridge> | null = null
  let listener: ((value: unknown) => void) | null = null
  const drafts = {
    acceptSend: vi.fn(),
    captureSendOrigin: vi.fn(() => ORIGIN),
    clearDraftForSend: vi.fn(),
    holdUnconfirmedSend: vi.fn(),
    restoreRejectedDraft: vi.fn()
  }
  const onSendError = vi.fn()
  const sendRequest = vi.fn()
  const subscribe = vi.fn((_method: string, _params: unknown, onData: (value: unknown) => void) => {
    listener = onData
    return vi.fn()
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the session reads only sendRequest and subscribe from its client.
  const client = { sendRequest, subscribe } as unknown as RpcClient

  function Harness(): null {
    const session = useMobileStructuredAgentSession({
      client,
      sessionId: 'session-1',
      sourceIdentity: 'host-a\0workspace-a',
      enabled: true,
      connected: true,
      hostSupport: null,
      agent: 'codex',
      onSendError
    })
    bridge = useMobileStructuredNativeChatSendBridge({
      agent: 'codex',
      sendStructured: session.sendWithOutcome,
      onSendError,
      ...drafts
    })
    return null
  }

  async function mountSession(): Promise<void> {
    act(() => {
      renderer = create(createElement(Harness))
    })
    await vi.waitFor(() => expect(listener).toEqual(expect.any(Function)))
    act(() => listener?.(snapshotEvent()))
  }

  /** The message and command mutations the phone asked the host for, in order. */
  function mutations(): string[] {
    return sendRequest.mock.calls
      .map(([method]) => String(method))
      .filter((method) => COMMAND_OR_MESSAGE_METHODS.has(method))
  }

  beforeEach(() => {
    vi.clearAllMocks()
    resetMobileStructuredSendOperationJournalForTests()
    const stored = new Map<string, string>()
    asyncStorage.getItem.mockImplementation(async (key: string) => stored.get(key) ?? null)
    asyncStorage.setItem.mockImplementation(async (key: string, value: string) => {
      stored.set(key, value)
    })
    asyncStorage.removeItem.mockImplementation(async (key: string) => {
      stored.delete(key)
    })
    sendRequest.mockImplementation(async (method: string) => {
      if (method === 'agentSession.send') {
        return ok({
          ok: true,
          replayed: false,
          fence: 3,
          cursor: { epoch: 'epoch-1', sequence: 1 },
          value: structuredSendResultFixture('accepted')
        })
      }
      return method === 'agentSession.options' ? ok({ models: [], current: {} }) : ok({})
    })
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    bridge = null
    listener = null
  })

  it('delivers a /model-titled answer as an ordinary message: no command, options untouched', async () => {
    await mountSession()
    const text = formatAsyncQuestionReply([{ title: '/model', answer: 'gpt-5' }])

    let outcome: string | undefined
    await act(async () => {
      outcome = await bridge!.answer(text)
    })

    expect(outcome).toBe('accepted')
    expect(mutations()).toEqual(['agentSession.send'])
    const sent = sendRequest.mock.calls.find(([method]) => method === 'agentSession.send')
    expect(JSON.stringify(sent?.[1])).toContain(JSON.stringify('Question: /model\nAnswer: gpt-5'))
    expect(drafts.acceptSend).toHaveBeenCalledWith(ORIGIN, 'Question: /model\nAnswer: gpt-5')
    expect(drafts.clearDraftForSend).not.toHaveBeenCalled()
    expect(drafts.restoreRejectedDraft).not.toHaveBeenCalled()
    expect(onSendError).not.toHaveBeenCalled()
  })

  // Control: the same gate does catch a typed command, so the answer above passed a live gate.
  it('routes a typed /model through the command gate, never as a message', async () => {
    await mountSession()

    await act(async () => {
      await bridge!.sendWithOutcome('/model gpt-5')
    })

    expect(mutations()).not.toContain('agentSession.send')
    expect(drafts.acceptSend).not.toHaveBeenCalled()
  })
})
