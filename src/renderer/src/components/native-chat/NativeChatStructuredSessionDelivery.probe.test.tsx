// The automatic probe of an outbox head with no answer: it resends under the same operation id,
// with backoff, until the host answers, and a head the host holds a row for never waits on it.

// @vitest-environment happy-dom

import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import type React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { mocks, moduleFactories, resetStructuredSessionMocks } = await vi.hoisted(async () =>
  (await import('./NativeChatStructuredSession.test-harness')).createStructuredSessionMocks()
)

vi.mock('@/runtime/structured-agent-session-client', () =>
  moduleFactories.structuredAgentSessionClient()
)
vi.mock('./use-structured-agent-session', () => moduleFactories.useStructuredAgentSession())
vi.mock('./use-native-chat-font-size', () => moduleFactories.useNativeChatFontSize())
vi.mock('./use-native-chat-file-link-context', () => moduleFactories.useNativeChatFileLinkContext())
vi.mock('./use-native-chat-file-link-click', () => moduleFactories.useNativeChatFileLinkClick())
vi.mock('./NativeChatMessageList', () => moduleFactories.nativeChatMessageList())
vi.mock('./NativeChatComposer', () => moduleFactories.nativeChatComposer())
vi.mock('./NativeChatEmptyState', () => moduleFactories.nativeChatEmptyState())
vi.mock('./NativeChatApprovalCard', () => moduleFactories.nativeChatApprovalCard())
vi.mock('./NativeChatQuestionCard', () => moduleFactories.nativeChatQuestionCard())

import { NativeChatStructuredSession } from './NativeChatStructuredSession'
import { advanceProbeClock, useProbeClock } from './NativeChatStructuredSession.test-harness'

/** The composer's send, as the pane hands it over. */
function composerSend(): (
  text: string,
  attachments: readonly { id: string; path: string }[]
) => boolean {
  const send = mocks.composerProps?.structuredTransport?.send
  if (typeof send !== 'function') {
    throw new Error('the composer was given no send')
  }
  return (text, attachments) => send(text, attachments) === true
}

/** The operation id a request carried, read without trusting its shape. */
function sentOperationId(params: unknown): string | undefined {
  if (typeof params !== 'object' || params === null || !('envelope' in params)) {
    return undefined
  }
  const { envelope } = params
  return typeof envelope === 'object' &&
    envelope !== null &&
    'clientOperationId' in envelope &&
    typeof envelope.clientOperationId === 'string'
    ? envelope.clientOperationId
    : undefined
}

/** The first text block a send request carried, read without trusting its shape. */
function sentText(params: unknown): string | undefined {
  if (typeof params !== 'object' || params === null || !('body' in params)) {
    return undefined
  }
  const { body } = params
  if (typeof body !== 'object' || body === null || !('blocks' in body)) {
    return undefined
  }
  const [first] = Array.isArray(body.blocks) ? body.blocks : []
  return typeof first === 'object' &&
    first !== null &&
    'text' in first &&
    typeof first.text === 'string'
    ? first.text
    : undefined
}

describe('NativeChatStructuredSession delivery probe', () => {
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    localStorage.clear()
    resetStructuredSessionMocks()
  })

  it('resends a transport-unconfirmed head so later messages are not wedged', async () => {
    useProbeClock()
    mocks.mode = 'outbox'
    mocks.submissions = []
    mocks.call.mockRejectedValueOnce(new Error('socket closed')).mockResolvedValue({
      ok: true,
      value: { submission: { clientMessageId: 'client-1', dispatchState: 'accepted' } }
    })

    render(
      <NativeChatStructuredSession
        isVisible
        isFocusedGroup
        tabId="structured-tab-wedge"
        sessionId="session-wedge"
        target={{ kind: 'local' }}
        agent="codex"
      />
    )

    const send = composerSend()
    await act(async () => {
      expect(send?.('first', [])).toBe(true)
    })
    expect(mocks.call).toHaveBeenCalledOnce()

    await act(async () => {
      expect(send?.('second', [])).toBe(true)
    })
    await advanceProbeClock(999)
    expect(mocks.call).toHaveBeenCalledOnce()
    await advanceProbeClock(1)
    // The head is probed automatically, clears, and the queue drains.
    expect(mocks.call).toHaveBeenCalledTimes(3)
    expect(screen.queryByText('Sending…')).toBeNull()
  }, 20000)

  it('probes the same operation without marking an explicit user retry', async () => {
    useProbeClock()
    mocks.mode = 'outbox'
    mocks.submissions = []
    mocks.call.mockRejectedValueOnce(new Error('socket closed')).mockResolvedValue({
      ok: true,
      value: { submission: { clientMessageId: 'client-1', dispatchState: 'accepted' } }
    })

    render(
      <NativeChatStructuredSession
        isVisible
        isFocusedGroup
        tabId="structured-tab-probe-flag"
        sessionId="session-probe-flag"
        target={{ kind: 'local' }}
        agent="codex"
      />
    )

    const send = composerSend()
    await act(async () => {
      expect(send?.('first', [])).toBe(true)
    })
    await advanceProbeClock(999)
    expect(mocks.call).toHaveBeenCalledOnce()
    await advanceProbeClock(1)
    expect(mocks.call).toHaveBeenCalledTimes(2)

    const [first, probe] = mocks.call.mock.calls.map((call) => call[2])
    expect(probe).not.toHaveProperty('retryUnknown')
    // Same operation id: both dedupe layers key off it.
    expect(sentOperationId(probe)).toBe(sentOperationId(first))
  }, 20000)

  it('lets a head the host answers in doubt leave, so the message behind it goes out (no parked head)', async () => {
    mocks.mode = 'outbox'
    mocks.call.mockRejectedValueOnce(new Error('socket closed')).mockResolvedValue({
      ok: true,
      value: { submission: { clientMessageId: 'client-1', dispatchState: 'accepted' } }
    })

    render(
      <NativeChatStructuredSession
        isVisible
        isFocusedGroup
        tabId="structured-tab-parked"
        sessionId="session-parked"
        target={{ kind: 'local' }}
        agent="codex"
      />
    )

    const send = composerSend()
    await act(async () => {
      expect(send?.('first', [])).toBe(true)
    })
    expect(mocks.call).toHaveBeenCalledOnce()

    const sentId = sentOperationId(mocks.call.mock.calls[0]?.[2])
    // The host now reports the row in doubt: it has a record, so the row shows it from here.
    mocks.submissions = [
      {
        clientMessageId: sentId,
        fence: 1,
        payloadFingerprint: 'fp',
        dispatchState: 'unknown',
        providerItemId: null,
        reason: null,
        submittedAt: 1,
        resolvedAt: null
      }
    ]
    // A later send, with no user action: it goes out instead of waiting behind the head.
    await act(async () => {
      send?.('second', [])
    })
    await waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(2), { timeout: 5000 })
    const texts = mocks.call.mock.calls.map((call) => sentText(call[2]))
    expect(texts).toEqual(['first', 'second'])
    // Neither waits on the user: no Retry anywhere.
    expect(screen.queryByRole('button', { name: /Retry/ })).toBeNull()
  }, 20000)

  it('still probes while streaming batches rebuild the submissions array', async () => {
    useProbeClock()
    mocks.mode = 'outbox'
    mocks.submissions = []
    mocks.call.mockRejectedValueOnce(new Error('socket closed')).mockResolvedValue({
      ok: true,
      value: { submission: { clientMessageId: 'client-1', dispatchState: 'accepted' } }
    })

    const makeView = (): React.ReactElement => (
      <NativeChatStructuredSession
        isVisible
        isFocusedGroup
        tabId="structured-tab-churn"
        sessionId="session-churn"
        target={{ kind: 'local' }}
        agent="codex"
      />
    )
    const { rerender } = render(makeView())

    const send = composerSend()
    await act(async () => {
      expect(send?.('first', [])).toBe(true)
    })
    expect(mocks.call).toHaveBeenCalledOnce()

    // Each batch mints a fresh submissions array for an unrelated message. An
    // array-identity dependency restarts the backoff on every one of these, so a
    // stream that outlasts the delay would never let the probe fire.
    for (let index = 0; index < 12; index += 1) {
      mocks.submissions = [
        {
          clientMessageId: `other-${index}`,
          fence: 1,
          payloadFingerprint: 'fp',
          dispatchState: 'accepted',
          providerItemId: null,
          reason: null,
          submittedAt: index,
          resolvedAt: index
        }
      ]
      await act(async () => {
        rerender(makeView())
        await vi.advanceTimersByTimeAsync(250)
      })
    }

    // Asserted with no trailing grace period: the probe must have fired *during*
    // the stream, not after it went quiet.
    expect(mocks.call).toHaveBeenCalledTimes(2)
  }, 20000)

  it('restarts probe delay when the runtime target changes', async () => {
    useProbeClock()
    mocks.mode = 'outbox'
    mocks.call.mockRejectedValueOnce(new Error('socket closed')).mockResolvedValue({
      ok: true,
      value: { submission: { clientMessageId: 'client-1', dispatchState: 'accepted' } }
    })

    const makeView = (
      target: { kind: 'local' } | { kind: 'environment'; environmentId: string }
    ) => (
      <NativeChatStructuredSession
        isVisible
        isFocusedGroup
        tabId="structured-tab-target-switch"
        sessionId="session-target-switch"
        target={target}
        agent="codex"
      />
    )
    const { rerender } = render(makeView({ kind: 'local' }))
    const send = composerSend()
    await act(async () => {
      expect(send?.('first', [])).toBe(true)
    })
    expect(mocks.call).toHaveBeenCalledOnce()
    // No answer is no failure: the message reads as sending while Orca resends it.
    expect(screen.getByText('Sending…')).toBeTruthy()

    await advanceProbeClock(300)
    rerender(makeView({ kind: 'environment', environmentId: 'env-1' }))
    await advanceProbeClock(600)
    expect(mocks.call).toHaveBeenCalledOnce()
    await advanceProbeClock(399)
    expect(mocks.call).toHaveBeenCalledOnce()
    await advanceProbeClock(1)
    expect(mocks.call).toHaveBeenCalledTimes(2)
  }, 10000)

  it('does not hot-loop when the host answers pending', async () => {
    useProbeClock()
    mocks.mode = 'outbox'
    mocks.call.mockResolvedValue({
      ok: true,
      value: { submission: { clientMessageId: 'client-1', dispatchState: 'pending' } }
    })

    render(
      <NativeChatStructuredSession
        isVisible
        isFocusedGroup
        tabId="structured-tab-pending"
        sessionId="session-pending"
        target={{ kind: 'local' }}
        agent="codex"
      />
    )

    const send = composerSend()
    await act(async () => {
      expect(send?.('first', [])).toBe(true)
    })
    expect(mocks.call).toHaveBeenCalledOnce()

    // A host-pending entry stays parked until the journal answers it.
    await advanceProbeClock(999)
    expect(mocks.call).toHaveBeenCalledOnce()
    await advanceProbeClock(1)
    expect(mocks.call).toHaveBeenCalledOnce()
    await advanceProbeClock(1500)
    expect(mocks.call).toHaveBeenCalledOnce()
  }, 20000)

  it('keeps probing past the old five-attempt budget', async () => {
    mocks.mode = 'outbox'
    mocks.call.mockRejectedValue(new Error('socket closed'))
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      render(
        <NativeChatStructuredSession
          isVisible
          isFocusedGroup
          tabId="structured-tab-budget"
          sessionId="session-budget"
          target={{ kind: 'local' }}
          agent="codex"
        />
      )

      const send = composerSend()
      expect(send?.('first', [])).toBe(true)

      // Backoff is 1+2+4+8+16 = 31s for five probes, which was the old hard budget.
      // Step past it; a seventh call proves the probe re-arms instead of giving up.
      for (let step = 0; step < 12; step += 1) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(8_000)
        })
      }
      expect(mocks.call.mock.calls.length).toBeGreaterThanOrEqual(7)
    } finally {
      vi.useRealTimers()
    }
  }, 30000)
})
