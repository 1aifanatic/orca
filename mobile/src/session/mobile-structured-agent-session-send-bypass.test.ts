// A resend past a saved record storage would not clear goes out under a fresh id. A retry of that
// text in the same app run must replay that id, never mint another: if the first resend's answer
// was lost, a second fresh id could deliver the message twice.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { markRpcDeliveryUnknown } from '../transport/rpc-delivery-ambiguity'
import type { RpcResponse } from '../transport/types'
import { DISPATCH_REJECTED_CANCELLED } from '../../../src/shared/structured-agent-session-dispatch-rejection'
import { sendMobileStructuredAgentSessionMessage } from './mobile-structured-agent-session-send'
import { resetMobileStructuredSendOperationJournalForTests } from './mobile-structured-send-operation-journal'

const asyncStorage = vi.hoisted(() => ({
  getItem: vi.fn(),
  setItem: vi.fn(),
  removeItem: vi.fn()
}))

vi.mock('@react-native-async-storage/async-storage', () => ({ default: asyncStorage }))

function ok(result: unknown): RpcResponse {
  return { id: 'request-1', ok: true, result, _meta: { runtimeId: 'runtime-1' } }
}

/** Its own submission, in that state: delivered, recorded and then rejected, or taken back by a
 *  Stop before the agent started it. */
function submissionAnswer(
  clientMessageId: string,
  answer: 'accepted' | 'recorded' | 'stopped'
): RpcResponse {
  return ok({
    ok: true,
    replayed: false,
    fence: 3,
    cursor: { epoch: 'epoch-1', sequence: 1 },
    value: {
      clientMessageId,
      submission: {
        clientMessageId,
        fence: 3,
        payloadFingerprint: 'fingerprint',
        dispatchState: answer === 'accepted' ? 'accepted' : 'rejected',
        providerItemId: null,
        reason:
          answer === 'stopped'
            ? DISPATCH_REJECTED_CANCELLED
            : answer === 'recorded'
              ? 'provider_write_failed: broken pipe'
              : null,
        submittedAt: 10,
        resolvedAt: 10
      }
    }
  })
}

function queuedAnswer(clientMessageId: string, state: 'waiting' | 'withdrawn'): RpcResponse {
  return ok({
    ok: true,
    replayed: false,
    fence: 3,
    cursor: { epoch: 'epoch-1', sequence: 1 },
    value: { clientMessageId, queued: { messageId: clientMessageId, position: 1, state } }
  })
}

/** Each `agentSession.send` answered in turn: a lost answer, a queued draft in that state, or its
 *  submission in that state. */
function hostAnswering(
  answers: readonly ('lost' | 'waiting' | 'withdrawn' | 'accepted' | 'recorded' | 'stopped')[]
) {
  const ids: string[] = []
  const deliveries: unknown[] = []
  const sendRequest = vi.fn<RpcClient['sendRequest']>(async (_method, params) => {
    const envelope = Object(Object(params).envelope)
    const id = String(envelope.clientOperationId)
    const answer = answers[ids.length]
    ids.push(id)
    deliveries.push(Object(params).delivery)
    if (answer === 'lost' || answer === undefined) {
      throw markRpcDeliveryUnknown(new Error('Connection closed'))
    }
    return answer === 'waiting' || answer === 'withdrawn'
      ? queuedAnswer(id, answer)
      : submissionAnswer(id, answer)
  })
  const client: RpcClient = {
    sendRequest,
    subscribe: vi.fn(() => vi.fn()),
    updateTerminalSubscriptionViewport: () => {},
    getState: () => 'connected',
    getReconnectAttempt: () => 0,
    getLastConnectedAt: () => null,
    onStateChange: () => () => {},
    notifyForeground: () => {},
    close: () => {}
  }
  return { client, ids, deliveries }
}

function sendAgain(client: RpcClient, onError: (message: string) => void, queue = true) {
  return sendMobileStructuredAgentSessionMessage({
    client,
    sessionId: 'session-1',
    sessionKey: 'host-a:session-1',
    callerIdentity: 'device-a',
    expectedRuntimeFence: 3,
    text: 'again',
    attachments: [],
    ...(queue ? { delivery: 'queue-if-active' as const } : {}),
    onError
  })
}

describe('a resend past a saved record storage would not clear', () => {
  let stored: Map<string, string>

  beforeEach(() => {
    vi.clearAllMocks()
    resetMobileStructuredSendOperationJournalForTests()
    stored = new Map()
    asyncStorage.getItem.mockImplementation(async (key: string) => stored.get(key) ?? null)
    asyncStorage.setItem.mockImplementation(async (key: string, value: string) => {
      stored.set(key, value)
    })
    asyncStorage.removeItem.mockImplementation(async (key: string) => {
      stored.delete(key)
    })
  })

  it('replays its own id once storage recovers, even without the queue capability now', async () => {
    const { client, ids, deliveries } = hostAnswering([
      'lost',
      'withdrawn',
      'lost',
      'withdrawn',
      'waiting'
    ])
    const onError = vi.fn()
    expect((await sendAgain(client, onError)).outcome).toBe('unknown')
    asyncStorage.setItem.mockRejectedValue(new Error('disk full'))
    asyncStorage.removeItem.mockRejectedValue(new Error('disk full'))
    expect((await sendAgain(client, onError)).outcome).toBe('unknown')
    // Storage recovers: the lost send's record now clears, and the queue capability is gone.
    asyncStorage.setItem.mockImplementation(async (key: string, value: string) => {
      stored.set(key, value)
    })
    asyncStorage.removeItem.mockImplementation(async (key: string) => {
      stored.delete(key)
    })
    expect((await sendAgain(client, onError, false)).outcome).toBe('queued')
    expect(ids).toHaveLength(5)
    // The resend's id is replayed, as first sent, never replaced by a fresh one.
    expect(ids[4]).toBe(ids[2])
    expect(deliveries[4]).toBe('queue-if-active')
  })

  it('replays its own id on a retry after a lost answer, and reports the record only once sent', async () => {
    // Lost first send; its withdrawn replay; the fresh resend's answer lost; the retry's
    // withdrawn replay; then the resend answered.
    const { client, ids } = hostAnswering(['lost', 'withdrawn', 'lost', 'withdrawn', 'waiting'])
    const onError = vi.fn()
    const send = () =>
      sendMobileStructuredAgentSessionMessage({
        client,
        sessionId: 'session-1',
        sessionKey: 'host-a:session-1',
        callerIdentity: 'device-a',
        expectedRuntimeFence: 3,
        text: 'again',
        attachments: [],
        delivery: 'queue-if-active',
        onError
      })
    expect((await send()).outcome).toBe('unknown')
    // From here the lost send's record can never be cleared.
    asyncStorage.setItem.mockRejectedValue(new Error('disk full'))
    asyncStorage.removeItem.mockRejectedValue(new Error('disk full'))

    expect((await send()).outcome).toBe('unknown')
    // An unconfirmed resend may not have gone out, so nothing says it was sent.
    expect(onError).not.toHaveBeenCalled()

    expect((await send()).outcome).toBe('queued')
    expect(ids).toHaveLength(5)
    expect(ids[1]).toBe(ids[0])
    expect(ids[3]).toBe(ids[0])
    expect(ids[2]).not.toBe(ids[0])
    // The retry replays the resend's id rather than minting one that could deliver twice.
    expect(ids[4]).toBe(ids[2])
    expect(onError).toHaveBeenCalledWith(
      "Sent, but this phone couldn't update its record of sent messages."
    )
  })

  // Lost first send; its withdrawn replay; the fresh resend's answer lost; the retry's withdrawn
  // replay; then that resend's own replay withdrawn too. A resend is sent once, never again.
  it('sends a withdrawn replay once more at most, then hands a queued draft back', async () => {
    const { client, ids } = hostAnswering(['lost', 'withdrawn', 'lost', 'withdrawn', 'withdrawn'])
    const onError = vi.fn()
    expect((await sendAgain(client, onError)).outcome).toBe('unknown')
    asyncStorage.setItem.mockRejectedValue(new Error('disk full'))
    asyncStorage.removeItem.mockRejectedValue(new Error('disk full'))
    expect((await sendAgain(client, onError)).outcome).toBe('unknown')

    expect((await sendAgain(client, onError)).outcome).toBe('rejected')
    expect(ids).toHaveLength(5)
    expect(ids[4]).toBe(ids[2])
    expect(onError).toHaveBeenCalledWith('Message not sent')
  })

  it('reads a resend a Stop took back again as sent, since the chat draws it, not as not sent', async () => {
    const { client, ids } = hostAnswering(['lost', 'stopped', 'lost', 'stopped', 'stopped'])
    const onError = vi.fn()
    expect((await sendAgain(client, onError, false)).outcome).toBe('unknown')
    asyncStorage.setItem.mockRejectedValue(new Error('disk full'))
    asyncStorage.removeItem.mockRejectedValue(new Error('disk full'))
    expect((await sendAgain(client, onError, false)).outcome).toBe('unknown')

    expect((await sendAgain(client, onError, false)).outcome).toBe('accepted')
    expect(ids).toHaveLength(5)
    expect(ids[4]).toBe(ids[2])
    // Only the storage failure is reported; nothing says the message was not sent.
    expect(onError.mock.calls).toEqual([
      ["Sent, but this phone couldn't update its record of sent messages."]
    ])
  })

  // Its row says it was not sent, so replaying the kept id would answer that again and do nothing.
  it('sends the same text as a new message when its kept id answers as recorded and rejected', async () => {
    const { client, ids } = hostAnswering(['lost', 'recorded', 'accepted'])
    const onError = vi.fn()
    expect(await sendAgain(client, onError, false)).toEqual({
      outcome: 'unknown',
      clientMessageId: ids[0]
    })
    // The answer names the fresh id, so the phone waits for that row, not the not-sent one.
    const resent = await sendAgain(client, onError, false)
    expect(ids).toHaveLength(3)
    expect(resent).toEqual({ outcome: 'accepted', clientMessageId: ids[2] })
    expect(ids[1]).toBe(ids[0])
    expect(ids[2]).not.toBe(ids[0])
    expect(onError).not.toHaveBeenCalled()
  })

  it('never says a resend went out when the host recorded and rejected it', async () => {
    const { client, ids } = hostAnswering(['lost', 'withdrawn', 'recorded'])
    const onError = vi.fn()
    expect((await sendAgain(client, onError)).outcome).toBe('unknown')
    asyncStorage.setItem.mockRejectedValue(new Error('disk full'))
    asyncStorage.removeItem.mockRejectedValue(new Error('disk full'))
    expect((await sendAgain(client, onError)).outcome).toBe('recorded-unsent')
    expect(ids).toHaveLength(3)
    expect(onError).not.toHaveBeenCalled()
  })

  it('leaves a replay of its own recorded rejection to the row once it was resent', async () => {
    const { client, ids } = hostAnswering(['lost', 'recorded', 'lost', 'recorded', 'recorded'])
    const onError = vi.fn()
    expect((await sendAgain(client, onError, false)).outcome).toBe('unknown')
    asyncStorage.setItem.mockRejectedValue(new Error('disk full'))
    asyncStorage.removeItem.mockRejectedValue(new Error('disk full'))
    expect((await sendAgain(client, onError, false)).outcome).toBe('unknown')
    // The resend's own id replays a recorded rejection: its row holds the text, nothing comes back.
    expect((await sendAgain(client, onError, false)).outcome).toBe('recorded-unsent')
    expect(ids).toHaveLength(5)
    expect(ids[4]).toBe(ids[2])
    expect(onError).not.toHaveBeenCalled()
  })
})
