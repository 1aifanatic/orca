// @vitest-environment happy-dom

// What the wire sees when queueing is available: `delivery` rides the send and
// its operation fingerprint only for a capable host with the setting on, a
// `queued` answer spends the entry, and everything else is byte-for-byte
// today's request — an older host must never see the key at all.

import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { structuredAgentSessionPayloadFingerprint } from '../../../../shared/structured-agent-session-mutation'

type SentParams = {
  envelope: { clientOperationId: string; sessionId: string; payloadFingerprint: string }
  body?: unknown
  delivery?: 'queue-if-active'
}

const mocks = vi.hoisted(() => ({
  call: vi.fn<(target: unknown, method: string, params: SentParams) => Promise<unknown>>()
}))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call
}))

import { useStructuredAgentSessionOutbox } from './use-structured-agent-session-outbox'

const LOCAL_TARGET = { kind: 'local' } as const

function queuedReceipt(clientMessageId: string) {
  return {
    ok: true,
    replayed: false,
    fence: 1,
    cursor: { epoch: 'epoch-1', sequence: 1 },
    value: {
      clientMessageId,
      queued: { messageId: clientMessageId, position: 1, state: 'waiting' as const }
    }
  }
}

function renderOutbox(queueDelivery: boolean) {
  return renderHook(() =>
    useStructuredAgentSessionOutbox({
      sessionId: 'session-1',
      target: LOCAL_TARGET,
      fence: 1,
      submissions: [],
      queueDelivery
    })
  )
}

async function sentParams(): Promise<SentParams> {
  await waitFor(() => expect(mocks.call).toHaveBeenCalled())
  const call = mocks.call.mock.calls[0]
  expect(call?.[1]).toBe('agentSession.send')
  const params = call?.[2]
  if (!params) {
    throw new Error('no send left the outbox')
  }
  return params
}

beforeEach(() => {
  localStorage.clear()
  mocks.call.mockReset()
})

afterEach(() => {
  localStorage.clear()
})

describe('outbox queue delivery selection', () => {
  it('stamps `delivery` on the send and its operation fingerprint when queueing is on', async () => {
    mocks.call.mockImplementation(async (_target, _method, params) =>
      queuedReceipt(params.envelope.clientOperationId)
    )
    const { result } = renderOutbox(true)
    expect(result.current.send('queue me')).toBe(true)
    const params = await sentParams()
    expect(params.delivery).toBe('queue-if-active')
    expect(params.envelope.payloadFingerprint).toBe(
      structuredAgentSessionPayloadFingerprint({
        method: 'agentSession.send',
        sessionId: 'session-1',
        fields: { body: params.body, delivery: 'queue-if-active' }
      })
    )
    // The host owns the draft now: the queued answer spends the outbox entry.
    await waitFor(() => expect(result.current.outbox).toHaveLength(0))
  })

  it("sends exactly today's request when the host lacks the capability or the setting is off", async () => {
    mocks.call.mockImplementation(async () => ({
      ok: true,
      replayed: false,
      fence: 1,
      cursor: { epoch: 'epoch-1', sequence: 1 },
      value: {
        clientMessageId: 'ignored',
        submission: {
          clientMessageId: 'ignored',
          fence: 1,
          payloadFingerprint: 'fingerprint',
          dispatchState: 'accepted',
          providerItemId: 'provider-1',
          reason: null,
          submittedAt: 1,
          resolvedAt: 1
        }
      }
    }))
    const { result } = renderOutbox(false)
    expect(result.current.send('plain send')).toBe(true)
    const params = await sentParams()
    expect('delivery' in params).toBe(false)
    expect(params.envelope.payloadFingerprint).toBe(
      structuredAgentSessionPayloadFingerprint({
        method: 'agentSession.send',
        sessionId: 'session-1',
        fields: { body: params.body }
      })
    )
  })

  it('routes an image send down the immediate path even with queueing on (text-only v1)', async () => {
    mocks.call.mockImplementation(async () => queuedReceipt('unused'))
    const { result } = renderOutbox(true)
    expect(
      result.current.send('with image', [{ path: '/tmp/a.png', previewUri: 'file:///tmp/a.png' }])
    ).toBe(true)
    const params = await sentParams()
    expect('delivery' in params).toBe(false)
  })

  it('retires an entry the host visibly holds as a draft, with no second copy of the text', async () => {
    // A queued send whose acknowledgement was lost: the entry survives under the
    // draft's own id, then the published draft list proves the host owns it.
    mocks.call.mockImplementation(() => new Promise(() => {}))
    const first = renderHook(
      (props: { queuedMessageIds: string[] }) =>
        useStructuredAgentSessionOutbox({
          sessionId: 'session-1',
          target: LOCAL_TARGET,
          fence: 1,
          submissions: [],
          queueDelivery: true,
          queuedMessageIds: props.queuedMessageIds
        }),
      { initialProps: { queuedMessageIds: Array.of<string>() } }
    )
    expect(first.result.current.send('lost ack')).toBe(true)
    await waitFor(() => expect(mocks.call).toHaveBeenCalled())
    const entryId = mocks.call.mock.calls[0]?.[2]?.envelope.clientOperationId
    expect(entryId).toBeTruthy()
    expect(first.result.current.outbox).toHaveLength(1)
    first.rerender({ queuedMessageIds: [entryId ?? ''] })
    await waitFor(() => expect(first.result.current.outbox).toHaveLength(0))
    // Retired, not restored: nothing to resend, nothing appended anywhere.
    expect(localStorage.getItem('orca:desktopStructuredAgentSessionOutbox:v1:session-1')).toBeNull()
    // The held draft answered the send, so the next one goes without waiting on the lost reply.
    expect(first.result.current.send('next')).toBe(true)
    await waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(2))
  })
})
