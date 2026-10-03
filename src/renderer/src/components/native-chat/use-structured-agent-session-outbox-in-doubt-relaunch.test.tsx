// @vitest-environment happy-dom

// A message the journal holds in doubt (its child ended before answering it) never held anything
// up. A queue an earlier build saved stuck behind one is freed once the chat opens again, read from
// the journal alone: the held message is never sent again and says nothing.

import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AGENT_SESSION_ACCEPTED_SEND_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import type { AgentJournalSubmission } from '../../../../shared/agent-session-journal-types'

const mocks = vi.hoisted(() => ({ call: vi.fn() }))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call
}))

import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/local-runtime-capabilities'
import { useStructuredAgentSessionOutbox } from './use-structured-agent-session-outbox'
import {
  createStructuredAgentSessionOutboxEntry,
  type StructuredAgentSessionOutboxEntry
} from '../../../../shared/structured-agent-session-outbox'
import { writeOutbox } from './structured-agent-session-outbox-storage'
import { structuredAgentSessionDeliveryNotices } from './structured-agent-session-delivery-notices'

const SESSION = 'session-1'
const LOCAL_TARGET = { kind: 'local' } as const

type SendRequest = { envelope?: { clientOperationId?: string } }

function sentIds(): string[] {
  return mocks.call.mock.calls.map((call) =>
    String((call[2] as SendRequest | undefined)?.envelope?.clientOperationId)
  )
}

function saved(
  clientMessageId: string,
  patch: Partial<StructuredAgentSessionOutboxEntry> = {}
): StructuredAgentSessionOutboxEntry {
  return {
    ...createStructuredAgentSessionOutboxEntry({
      clientMessageId,
      sessionId: SESSION,
      text: clientMessageId,
      attachments: [],
      queuedAt: 1
    }),
    ...patch
  }
}

/** What the host wrote when the child ended with the follow-up unanswered. */
const IN_DOUBT: AgentJournalSubmission = {
  clientMessageId: 'op-follow-up',
  fence: 1,
  payloadFingerprint: 'fingerprint',
  dispatchState: 'unknown',
  providerItemId: null,
  reason: 'provider_closed_before_acknowledgement',
  submittedAt: 2,
  resolvedAt: 3,
  recovered: true
}

function accepted(clientMessageId: string) {
  return {
    ok: true,
    replayed: false,
    fence: 1,
    cursor: { epoch: 'epoch-1', sequence: 4 },
    value: {
      clientMessageId,
      submission: {
        clientMessageId,
        fence: 1,
        payloadFingerprint: 'fingerprint',
        dispatchState: 'accepted',
        providerItemId: `provider-${clientMessageId}`,
        reason: null,
        submittedAt: 4,
        resolvedAt: 4
      }
    }
  }
}

describe('a queue saved behind a message the host holds in doubt', () => {
  afterEach(() => {
    cleanup()
    setLocalRuntimeCapabilitiesForTests(null)
  })

  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    setLocalRuntimeCapabilitiesForTests([AGENT_SESSION_ACCEPTED_SEND_RUNTIME_CAPABILITY])
    mocks.call.mockImplementation((_target, _method, params: SendRequest) =>
      Promise.resolve(accepted(String(params.envelope?.clientOperationId)))
    )
  })

  it.each([
    ['held as unconfirmed', 'unconfirmed'],
    ['left on its way out', 'dispatching']
  ] as const)(
    'sends the message behind it when the chat opens again, the held one %s',
    async (_case, state) => {
      writeOutbox(SESSION, [saved('op-follow-up', { state, lastAttemptAt: 2 }), saved('op-next')])

      const { result } = renderHook(() =>
        useStructuredAgentSessionOutbox({
          sessionId: SESSION,
          target: LOCAL_TARGET,
          fence: 1,
          submissions: [IN_DOUBT]
        })
      )

      await waitFor(() => expect(sentIds()).toEqual(['op-next']))
      // Past the unconfirmed probe's first delay: the held message is never sent again.
      await act(() => new Promise<void>((resolve) => setTimeout(resolve, 1_200)))
      expect(sentIds()).toEqual(['op-next'])
      expect(result.current.outbox.map((entry) => entry.clientMessageId)).toEqual(['op-follow-up'])
      expect(
        structuredAgentSessionDeliveryNotices(
          result.current.outbox,
          'Codex',
          result.current.retry,
          [IN_DOUBT],
          [],
          result.current.failedHere
        ).size
      ).toBe(0)
    }
  )

  // The probe skips the one the host holds and resends the one it may not have.
  it('probes a message the host may never have received, saved behind one it holds', async () => {
    writeOutbox(SESSION, [
      saved('op-follow-up', { state: 'unconfirmed', lastAttemptAt: 2 }),
      saved('op-lost', { state: 'unconfirmed', lastAttemptAt: 3 }),
      saved('op-next')
    ])

    renderHook(() =>
      useStructuredAgentSessionOutbox({
        sessionId: SESSION,
        target: LOCAL_TARGET,
        fence: 1,
        submissions: [IN_DOUBT]
      })
    )

    await waitFor(() => expect(sentIds()).toEqual(['op-lost', 'op-next']), { timeout: 5_000 })
  })

  it('holds the queue until the journal shows the host has it, then sends what waits', async () => {
    // Retried once already, so the probe leaves it alone and only the journal can free the queue.
    writeOutbox(SESSION, [
      saved('op-follow-up', {
        state: 'unconfirmed',
        lastAttemptAt: 2,
        retryAfterUnknownSubmittedAt: -1
      }),
      saved('op-next')
    ])
    const { rerender } = renderHook(
      ({ submissions }: { submissions: readonly AgentJournalSubmission[] }) =>
        useStructuredAgentSessionOutbox({
          sessionId: SESSION,
          target: LOCAL_TARGET,
          fence: 1,
          submissions
        }),
      { initialProps: { submissions: [] as readonly AgentJournalSubmission[] } }
    )
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 100)))
    expect(sentIds()).toEqual([])

    rerender({ submissions: [IN_DOUBT] })
    await waitFor(() => expect(sentIds()).toEqual(['op-next']))
  })
})
