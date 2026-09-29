// @vitest-environment happy-dom

// A queued follow-up whose delivery is in doubt survives a Stop, since the host may hold it as a
// paused card. From then on only the user's Retry sends it: the unconfirmed probe resending it
// onto the now-idle session would start a turn the user just stopped.

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createStructuredAgentSessionOutboxEntry } from '../../../../shared/structured-agent-session-outbox'

type SentParams = { envelope: { clientOperationId: string } }

const mocks = vi.hoisted(() => ({
  call: vi.fn<(target: unknown, method: string, params: SentParams) => Promise<unknown>>()
}))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call
}))

import { useStructuredAgentSessionOutbox } from './use-structured-agent-session-outbox'
import { readOutbox, writeOutbox } from './structured-agent-session-outbox-storage'

const TARGET = { kind: 'local' } as const

beforeEach(() => {
  localStorage.clear()
  mocks.call.mockReset()
  mocks.call.mockImplementation(() => new Promise(() => {}))
  vi.useFakeTimers({ shouldAdvanceTime: true })
})

afterEach(() => {
  vi.useRealTimers()
  localStorage.clear()
})

describe('a Stop with a queued send in doubt', () => {
  it('never resends it on its own, and the user can still Retry it', async () => {
    writeOutbox('session-1', [
      {
        ...createStructuredAgentSessionOutboxEntry({
          clientMessageId: 'in-doubt',
          sessionId: 'session-1',
          text: 'follow-up',
          attachments: [],
          queuedAt: 1,
          delivery: 'queue-if-active'
        }),
        state: 'unconfirmed'
      }
    ])
    const { result } = renderHook(() =>
      useStructuredAgentSessionOutbox({
        sessionId: 'session-1',
        target: TARGET,
        fence: 1,
        submissions: [],
        composerScopeKey: 'scope',
        queueDelivery: true
      })
    )
    act(() => {
      result.current.withdrawUnsent()
    })
    // Past the probe's longest backoff several times over.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(mocks.call).not.toHaveBeenCalled()
    expect(result.current.outbox.map((entry) => entry.state)).toEqual(['unconfirmed'])
    expect(readOutbox('session-1').map((entry) => entry.clientMessageId)).toEqual(['in-doubt'])

    act(() => {
      result.current.retry('in-doubt')
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    // The same operation: a host that got the first attempt replays its answer.
    expect(mocks.call.mock.calls.map((call) => call[2].envelope.clientOperationId)).toEqual([
      'in-doubt'
    ])
  })
})
