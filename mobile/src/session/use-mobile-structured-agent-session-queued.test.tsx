// The mid-turn queue on mobile: `delivery` rides only capability-gated sends,
// published drafts render as cards (never optimistic bubbles), card actions map
// to the queued-message RPCs, and a withdrawing Stop restores text through a
// write-ahead persisted operation that survives reload. An incapable host gets
// exactly today's requests.

import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentSessionQueuedMessage,
  AgentSessionSubscribeEvent
} from '../../../src/shared/agent-session-wire'
import { structuredAgentSessionPayloadFingerprint } from '../../../src/shared/structured-agent-session-mutation'
import type { RpcClient } from '../transport/rpc-client'
import { markRpcDeliveryUnknown } from '../transport/rpc-delivery-ambiguity'
import { resetMobileStructuredSendOperationJournalForTests } from './mobile-structured-send-operation-journal'
import {
  getOrCreateQueuedRestoreOperation,
  queuedRestoreEntryKey,
  resetQueuedRestoreJournalForTests
} from './mobile-structured-queued-restore-journal'
import { expectedClearReplacementSessionId } from './mobile-structured-queued-message-actions'
import { structuredSessionOperationId } from './structured-session-operation-id'
import type { StructuredAgentSessionHostSupport } from './mobile-structured-agent-session-host-support'
import { useMobileStructuredAgentSession } from './use-mobile-structured-agent-session'

const asyncStorage = vi.hoisted(() => ({
  getItem: vi.fn(),
  setItem: vi.fn(),
  removeItem: vi.fn()
}))

vi.mock('@react-native-async-storage/async-storage', () => ({ default: asyncStorage }))

const SESSION_ID = 'session-1'
const DRAFT_KEY = 'host\0worktree\0tab-1'

const CAPABLE: StructuredAgentSessionHostSupport = {
  promptCancel: false,
  questionAnswers: false,
  queuedMessages: true
}
const LEGACY: StructuredAgentSessionHostSupport = { ...CAPABLE, queuedMessages: false }

function ok(result: unknown) {
  return { ok: true, result, _meta: { runtimeId: 'runtime-1' } }
}

function mutationOk(value: unknown) {
  return ok({
    ok: true,
    replayed: false,
    fence: 3,
    cursor: { epoch: 'epoch-1', sequence: 1 },
    value
  })
}

function queuedDraft(
  overrides: Partial<AgentSessionQueuedMessage> & { messageId: string }
): AgentSessionQueuedMessage {
  return {
    position: 1,
    body: {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: `text of ${overrides.messageId}` }]
    },
    state: 'waiting',
    ...overrides
  }
}

function snapshotEvent(input?: {
  queuedMessages?: AgentSessionQueuedMessage[] | null
  runningTurn?: boolean
}): AgentSessionSubscribeEvent {
  return {
    type: 'snapshot',
    sessionId: SESSION_ID,
    fence: 3,
    page: {
      sessionId: SESSION_ID,
      epoch: 'epoch-1',
      fence: 3,
      direction: 'tail',
      items: input?.runningTurn
        ? [
            {
              itemId: 'turn-item-1',
              revision: 1,
              body: { kind: 'turn', turnId: 'turn-1', state: 'running' },
              sequence: 1,
              observedAt: 1
            }
          ]
        : [],
      removedItemIds: [],
      submissions: [],
      window: { oldest: null, newest: null, nextCursor: { epoch: 'epoch-1', sequence: 0 } },
      liveCursor: { epoch: 'epoch-1', sequence: 0 },
      hasOlder: false,
      hasNewer: false
    },
    ...(input?.queuedMessages !== undefined ? { queuedMessages: input.queuedMessages } : {})
  }
}

function batchEvent(
  queuedMessages?: AgentSessionQueuedMessage[] | null
): AgentSessionSubscribeEvent {
  return {
    type: 'batch',
    sessionId: SESSION_ID,
    batch: {
      cursor: { epoch: 'epoch-1', sequence: 2 },
      items: [],
      removedItemIds: [],
      submissions: []
    },
    ...(queuedMessages !== undefined ? { queuedMessages } : {})
  }
}

describe('mobile structured queued messages', () => {
  let renderer: ReactTestRenderer | null = null
  let hook: ReturnType<typeof useMobileStructuredAgentSession> | null = null
  let listener: ((value: unknown) => void) | null = null
  let stored: Map<string, string>
  const onSendError = vi.fn()
  const appendText = vi.fn()
  const sendRequest = vi.fn()
  const subscribe = vi.fn((_method: string, _params: unknown, onData: (value: unknown) => void) => {
    listener = onData
    return vi.fn()
  })
  const client = { sendRequest, subscribe } as unknown as RpcClient

  function Harness({
    hostSupport,
    sessionId = SESSION_ID
  }: {
    hostSupport: StructuredAgentSessionHostSupport
    sessionId?: string
  }): null {
    hook = useMobileStructuredAgentSession({
      client,
      sessionId,
      sourceIdentity: 'host-a\0workspace-a',
      enabled: true,
      connected: true,
      agent: 'claude',
      hostSupport,
      composerRestore: { readDraftKey: () => DRAFT_KEY, appendText },
      onSendError
    } as never)
    return null
  }

  async function mountSession(
    hostSupport: StructuredAgentSessionHostSupport,
    event: AgentSessionSubscribeEvent = snapshotEvent(),
    sessionId?: string
  ): Promise<void> {
    act(() => {
      renderer = create(
        createElement(Harness, { hostSupport, ...(sessionId ? { sessionId } : {}) })
      )
    })
    await vi.waitFor(() => expect(listener).toEqual(expect.any(Function)))
    act(() => listener?.(event))
  }

  function unmountSession(): void {
    act(() => renderer?.unmount())
    renderer = null
    hook = null
    listener = null
  }

  function calls(method: string) {
    return sendRequest.mock.calls.filter(([calledMethod]) => calledMethod === method)
  }

  beforeEach(() => {
    vi.clearAllMocks()
    resetMobileStructuredSendOperationJournalForTests()
    resetQueuedRestoreJournalForTests()
    stored = new Map()
    asyncStorage.getItem.mockImplementation(async (key: string) => stored.get(key) ?? null)
    asyncStorage.setItem.mockImplementation(async (key: string, value: string) => {
      stored.set(key, value)
    })
    asyncStorage.removeItem.mockImplementation(async (key: string) => {
      stored.delete(key)
    })
    sendRequest.mockImplementation(async (method) =>
      method === 'agentSession.options' ? ok({ models: [], current: {} }) : ok({})
    )
  })

  afterEach(() => {
    unmountSession()
  })

  describe('capability-gated delivery', () => {
    it('sends delivery: queue-if-active — fingerprint included — only on a capable host', async () => {
      sendRequest.mockImplementation(async (method) => {
        if (method === 'agentSession.send') {
          return mutationOk({
            clientMessageId: 'client-1',
            queued: { messageId: 'client-1', position: 1, state: 'waiting' }
          })
        }
        return method === 'agentSession.options' ? ok({ models: [], current: {} }) : ok({})
      })
      await mountSession(CAPABLE)
      await act(async () => {
        expect(await hook!.sendWithOutcome('queue me')).toBe('queued')
      })
      const [, params] = calls('agentSession.send')[0]! as [
        string,
        { envelope: { payloadFingerprint: string }; body: unknown; delivery?: string }
      ]
      expect(params.delivery).toBe('queue-if-active')
      expect(params.envelope.payloadFingerprint).toBe(
        structuredAgentSessionPayloadFingerprint({
          method: 'agentSession.send',
          sessionId: SESSION_ID,
          fields: { body: params.body, delivery: 'queue-if-active' }
        })
      )
      // Spent at `queued`: the durable send-operation entry is released.
      await vi.waitFor(() =>
        expect(stored.has('orca:mobileStructuredSendOperations:v1')).toBe(false)
      )
    })

    it('keeps today’s request exactly against an incapable host', async () => {
      sendRequest.mockImplementation(async (method) => {
        if (method === 'agentSession.send') {
          return mutationOk({
            clientMessageId: 'client-1',
            submission: {
              clientMessageId: 'client-1',
              fence: 3,
              payloadFingerprint: 'fp',
              dispatchState: 'accepted',
              providerItemId: null,
              reason: null,
              submittedAt: 10,
              resolvedAt: 10
            }
          })
        }
        return method === 'agentSession.options' ? ok({ models: [], current: {} }) : ok({})
      })
      await mountSession(LEGACY)
      await act(async () => {
        expect(await hook!.sendWithOutcome('plain send')).toBe('accepted')
      })
      const [, params] = calls('agentSession.send')[0]! as [
        string,
        { envelope: { payloadFingerprint: string }; body: unknown }
      ]
      expect('delivery' in params).toBe(false)
      expect(params.envelope.payloadFingerprint).toBe(
        structuredAgentSessionPayloadFingerprint({
          method: 'agentSession.send',
          sessionId: SESSION_ID,
          fields: { body: params.body }
        })
      )
    })

    it('replays an ack-lost delivery send under one id and the recorded delivery field', async () => {
      let attempts = 0
      sendRequest.mockImplementation(async (method) => {
        if (method === 'agentSession.send') {
          attempts += 1
          throw markRpcDeliveryUnknown(new Error('Connection closed'))
        }
        return method === 'agentSession.options' ? ok({ models: [], current: {} }) : ok({})
      })
      await mountSession(CAPABLE)
      await act(async () => {
        expect(await hook!.sendWithOutcome('retry me')).toBe('unknown')
      })
      unmountSession()
      // The capability probe has not answered after the reload, but the recorded
      // operation must replay bit-for-bit — content-derived key, same id, same
      // delivery field — or the host would refuse it as a fingerprint conflict.
      await mountSession(LEGACY)
      await act(async () => {
        expect(await hook!.sendWithOutcome('retry me')).toBe('unknown')
      })
      expect(attempts).toBe(2)
      const [first, second] = calls('agentSession.send') as [string, Record<string, unknown>][]
      expect((second[1] as { delivery?: string }).delivery).toBe('queue-if-active')
      expect(
        (second[1] as { envelope: { clientOperationId: string } }).envelope.clientOperationId
      ).toBe((first[1] as { envelope: { clientOperationId: string } }).envelope.clientOperationId)
    })
  })

  describe('cards from the published list', () => {
    it('renders published drafts as cards and follows later frames', async () => {
      await mountSession(
        CAPABLE,
        snapshotEvent({ queuedMessages: [queuedDraft({ messageId: 'draft-1' })] })
      )
      expect(hook!.queued.cards).toEqual([
        {
          messageId: 'draft-1',
          text: 'text of draft-1',
          state: 'waiting',
          paused: false,
          label: 'Queued — sends when the current turn ends'
        }
      ])
      // A frame without the field leaves the list alone; null empties it.
      act(() => listener?.(batchEvent()))
      expect(hook!.queued.cards).toHaveLength(1)
      act(() => listener?.(batchEvent(null)))
      expect(hook!.queued.cards).toEqual([])
    })

    it('shows no cards from an incapable host even if a list arrives', async () => {
      await mountSession(
        LEGACY,
        snapshotEvent({ queuedMessages: [queuedDraft({ messageId: 'draft-1' })] })
      )
      expect(hook!.queued.cards).toEqual([])
    })
  })

  describe('card actions', () => {
    it('Send-now consumes through agentSession.queuedMessageSend', async () => {
      sendRequest.mockImplementation(async (method) => {
        if (method === 'agentSession.queuedMessageSend') {
          return mutationOk({
            clientMessageId: 'draft-1',
            submission: {
              clientMessageId: 'draft-1',
              fence: 3,
              payloadFingerprint: 'fp',
              dispatchState: 'pending',
              providerItemId: null,
              reason: null,
              submittedAt: 10,
              resolvedAt: null
            }
          })
        }
        return method === 'agentSession.options' ? ok({ models: [], current: {} }) : ok({})
      })
      await mountSession(CAPABLE)
      await act(async () => {
        expect(await hook!.queued.send('draft-1')).toBe(true)
      })
      const [, params] = calls('agentSession.queuedMessageSend')[0]! as [
        string,
        { messageId: string }
      ]
      expect(params.messageId).toBe('draft-1')
    })

    it('Delete reads the union result: a dispatched draft was already sent', async () => {
      sendRequest.mockImplementation(async (method) => {
        if (method === 'agentSession.queuedMessageDelete') {
          return mutationOk({ deleted: false, messageId: 'draft-1', disposition: 'dispatched' })
        }
        return method === 'agentSession.options' ? ok({ models: [], current: {} }) : ok({})
      })
      await mountSession(CAPABLE)
      await act(async () => {
        expect(await hook!.queued.delete('draft-1')).toBe(false)
      })
      expect(onSendError).toHaveBeenCalledWith('This message was already sent.')
    })

    it('Edit deletes the draft and returns its body to this pane’s composer', async () => {
      sendRequest.mockImplementation(async (method) => {
        if (method === 'agentSession.queuedMessageDelete') {
          return mutationOk({
            deleted: true,
            messageId: 'draft-1',
            body: {
              kind: 'message',
              role: 'user',
              blocks: [{ type: 'text', text: 'edit me' }]
            }
          })
        }
        return method === 'agentSession.options' ? ok({ models: [], current: {} }) : ok({})
      })
      await mountSession(CAPABLE)
      await act(async () => {
        expect(await hook!.queued.edit('draft-1')).toBe(true)
      })
      expect(appendText).toHaveBeenCalledWith(DRAFT_KEY, 'edit me')
      // Its restoration settled, so the write-ahead entry is gone.
      expect(stored.has('orca:mobileStructuredQueuedRestore:v1')).toBe(false)
    })
  })

  describe('Stop withdraws and restores', () => {
    function stopAnswers() {
      sendRequest.mockImplementation(async (method) => {
        if (method === 'agentSession.cancel') {
          return mutationOk({
            cancelled: true,
            turnId: 'turn-1',
            withdrawnQueued: [
              {
                messageId: 'draft-1',
                body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'one' }] }
              },
              {
                messageId: 'draft-2',
                body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'two' }] }
              }
            ]
          })
        }
        return method === 'agentSession.options' ? ok({ models: [], current: {} }) : ok({})
      })
    }

    it('a capable Stop carries withdrawQueued, persists ahead, restores each body once', async () => {
      stopAnswers()
      await mountSession(CAPABLE, snapshotEvent({ runningTurn: true }))
      await act(async () => {
        expect(await hook!.cancelPrompt()).toBe(true)
      })
      const [, params] = calls('agentSession.cancel')[0]! as [
        string,
        { turnId: string; withdrawQueued?: true }
      ]
      expect(params.turnId).toBe('turn-1')
      expect(params.withdrawQueued).toBe(true)
      // Write-ahead: the operation identity reached storage before the RPC left.
      const restoreWrite = asyncStorage.setItem.mock.invocationCallOrder.find(
        (_, index) =>
          asyncStorage.setItem.mock.calls[index]?.[0] === 'orca:mobileStructuredQueuedRestore:v1'
      )
      const cancelCall = sendRequest.mock.invocationCallOrder.find(
        (_, index) => sendRequest.mock.calls[index]?.[0] === 'agentSession.cancel'
      )
      expect(restoreWrite).toBeLessThan(cancelCall!)
      // Every withdrawn body comes back as its own restored draft, newest typing untouched.
      expect(appendText.mock.calls).toEqual([
        [DRAFT_KEY, 'one'],
        [DRAFT_KEY, 'two']
      ])
      expect(stored.has('orca:mobileStructuredQueuedRestore:v1')).toBe(false)
    })

    it('an incapable Stop is exactly today’s cancel', async () => {
      sendRequest.mockImplementation(async (method) => {
        if (method === 'agentSession.cancel') {
          return mutationOk({ cancelled: true, turnId: 'turn-1' })
        }
        return method === 'agentSession.options' ? ok({ models: [], current: {} }) : ok({})
      })
      await mountSession(LEGACY, snapshotEvent({ runningTurn: true }))
      await act(async () => {
        expect(await hook!.cancelPrompt()).toBe(true)
      })
      const [, params] = calls('agentSession.cancel')[0]! as [string, Record<string, unknown>]
      expect('withdrawQueued' in params).toBe(false)
      expect(asyncStorage.setItem).not.toHaveBeenCalledWith(
        'orca:mobileStructuredQueuedRestore:v1',
        expect.anything()
      )
    })

    it('a persisted Stop NEVER re-executes on a later launch; its handle is dropped', async () => {
      // A cancel the host never received would run fresh if reissued —
      // withdrawing the pane's current drafts and rejecting queued sends — so
      // relaunch recovery drops the handle and the host keeps the cards.
      sendRequest.mockImplementation(async (method) => {
        if (method === 'agentSession.cancel') {
          throw markRpcDeliveryUnknown(new Error('Connection closed'))
        }
        return method === 'agentSession.options' ? ok({ models: [], current: {} }) : ok({})
      })
      await mountSession(CAPABLE, snapshotEvent({ runningTurn: true }))
      await act(async () => {
        expect(await hook!.cancelPrompt()).toBe(false)
      })
      expect(calls('agentSession.cancel')).toHaveLength(1)
      expect(stored.has('orca:mobileStructuredQueuedRestore:v1')).toBe(true)
      unmountSession()

      stopAnswers()
      await mountSession(CAPABLE, snapshotEvent({ runningTurn: true }))
      await vi.waitFor(() =>
        expect(stored.has('orca:mobileStructuredQueuedRestore:v1')).toBe(false)
      )
      expect(calls('agentSession.cancel')).toHaveLength(1)
      expect(appendText).not.toHaveBeenCalled()
    })
  })

  describe('persisted /clear across relaunch', () => {
    async function persistClearEntry(sourceSessionId: string): Promise<string> {
      const entryKey = queuedRestoreEntryKey({
        sessionKey: 'any',
        method: 'agentSession.conversationCommand',
        fields: { command: 'clear' }
      })
      const { operationId } = await getOrCreateQueuedRestoreOperation({
        entryKey,
        sessionId: sourceSessionId,
        sessionKey: 'any',
        draftKey: DRAFT_KEY,
        method: 'agentSession.conversationCommand',
        fields: { command: 'clear' },
        createOperationId: structuredSessionOperationId
      })
      return operationId
    }

    it('killed before the clear reached the host: no command runs on relaunch', async () => {
      await persistClearEntry(SESSION_ID)
      await mountSession(CAPABLE)
      await act(async () => {})
      expect(calls('agentSession.conversationCommand')).toHaveLength(0)
      // The handle stays for a same-id user retry until it expires on its own.
      expect(stored.has('orca:mobileStructuredQueuedRestore:v1')).toBe(true)
    })

    it('killed after the clear applied: the recorded text is restored exactly once', async () => {
      const operationId = await persistClearEntry('session-src')
      // The pane now shows the replacement session this very operation minted —
      // the proof the clear committed, so a same-op reissue can only replay.
      const replacement = expectedClearReplacementSessionId(
        { sessionId: 'session-src', operationId },
        ''
      )
      sendRequest.mockImplementation(async (method) => {
        if (method === 'agentSession.conversationCommand') {
          return mutationOk({
            command: 'clear',
            state: 'completed',
            replacementSessionId: replacement,
            withdrawnQueued: [
              {
                messageId: 'draft-1',
                body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'held' }] }
              }
            ]
          })
        }
        return method === 'agentSession.options' ? ok({ models: [], current: {} }) : ok({})
      })
      await mountSession(CAPABLE, snapshotEvent(), replacement)
      await vi.waitFor(() => expect(calls('agentSession.conversationCommand')).toHaveLength(1))
      const [, params] = calls('agentSession.conversationCommand')[0]! as [
        string,
        { envelope: { sessionId: string; clientOperationId: string }; withdrawQueued?: true }
      ]
      // The reissue targets the SOURCE under the recorded id: a pure replay.
      expect(params.envelope.sessionId).toBe('session-src')
      expect(params.envelope.clientOperationId).toBe(operationId)
      expect(params.withdrawQueued).toBe(true)
      await vi.waitFor(() => expect(appendText.mock.calls).toEqual([[DRAFT_KEY, 'held']]))
      await vi.waitFor(() =>
        expect(stored.has('orca:mobileStructuredQueuedRestore:v1')).toBe(false)
      )
      unmountSession()

      // A second launch owes nothing.
      await mountSession(CAPABLE, snapshotEvent(), replacement)
      await act(async () => {})
      expect(calls('agentSession.conversationCommand')).toHaveLength(1)
      expect(appendText.mock.calls).toHaveLength(1)
    })
  })
})
