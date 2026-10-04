// @vitest-environment happy-dom

// A Stop naming no turn: the sends it outran are stamped with its own id before it goes, its
// answer is recorded on them, and a Stop whose answer was lost goes again under the same id until
// it meets one, unless a newer message exists, which a resend could stop instead.

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createStructuredAgentSessionOutboxEntry,
  type StructuredAgentSessionOutboxEntry
} from '../../../../shared/structured-agent-session-outbox'
import { createStructuredAgentSessionOperationId } from '../../../../shared/structured-agent-session-mutation'
import type { AgentJournalSubmission } from '../../../../shared/agent-session-journal-types'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { useStructuredAgentSessionConversationStop } from './use-structured-agent-session-conversation-stop'
import type {
  StructuredAgentSessionWriteAs,
  StructuredAgentSessionWriteOutcome
} from './use-structured-agent-session-mutate'

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

afterEach(cleanup)

let uuid = 0
beforeEach(() => {
  uuid = 0
  vi.spyOn(globalThis.crypto, 'randomUUID').mockImplementation(() => {
    uuid += 1
    return `11111111-1111-4111-8111-${uuid.toString(16).padStart(12, '0')}`
  })
  vi.useFakeTimers({ shouldAdvanceTime: true })
})

afterEach(() => {
  vi.useRealTimers()
})

const DONE: StructuredAgentSessionWriteOutcome<unknown> = {
  kind: 'done',
  value: { cancelled: true },
  operationId: 'ignored',
  cursor: { epoch: 'e', sequence: 9 }
}

function stamped(stopId: string, queuedAt = 1): StructuredAgentSessionOutboxEntry {
  return {
    ...createStructuredAgentSessionOutboxEntry({
      clientMessageId: 'out',
      sessionId: 'session-1',
      text: 'out',
      attachments: [],
      queuedAt
    }),
    state: 'unconfirmed',
    lastAttemptAt: 1,
    stoppedBy: { operationId: stopId }
  }
}

type StopWrite = (stopId: string) => Promise<StructuredAgentSessionWriteOutcome<unknown>>

function asWriteAs(write: StopWrite): StructuredAgentSessionWriteAs {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the Stop hook calls writeAs only for agentSession.cancel and reads kind, cursor, answered and notice, never the value's type.
  return write as unknown as StructuredAgentSessionWriteAs
}

function harness(writeAs: StopWrite) {
  const stopOutbox = vi.fn()
  const recordStopAnswer = vi.fn()
  const view = renderHook(
    (props: {
      outbox: StructuredAgentSessionOutboxEntry[]
      submissions?: AgentJournalSubmission[]
    }) =>
      useStructuredAgentSessionConversationStop({
        outbox: props.outbox,
        submissions: props.submissions ?? [],
        attached: true,
        writeAs: asWriteAs(writeAs),
        stopOutbox,
        recordStopAnswer
      }),
    {
      initialProps: {
        outbox: Array.of<StructuredAgentSessionOutboxEntry>(),
        submissions: Array.of<AgentJournalSubmission>()
      }
    }
  )
  return { view, stopOutbox, recordStopAnswer }
}

describe('a conversation Stop', () => {
  it('stamps the outbox with its own id, sends under that id, and records where the journal stood', async () => {
    const writeAs = vi.fn<StopWrite>(async () => DONE)
    const { view, stopOutbox, recordStopAnswer } = harness(writeAs)
    await act(async () => {
      await view.result.current()
    })
    const stopId = stopOutbox.mock.calls[0]?.[0]
    expect(writeAs).toHaveBeenCalledWith(stopId, 'agentSession.cancel', 'agentSession.cancel', {})
    expect(recordStopAnswer).toHaveBeenCalledWith(stopId, {
      kind: 'answered',
      cursor: { epoch: 'e', sequence: 9 }
    })
  })

  it('records a refused Stop as one that will never be answered', async () => {
    const writeAs = vi.fn<StopWrite>(async () => ({
      kind: 'not-done',
      notice: 'No.',
      answered: true
    }))
    const { view, stopOutbox, recordStopAnswer } = harness(writeAs)
    await act(async () => {
      await view.result.current()
    })
    expect(recordStopAnswer).toHaveBeenCalledWith(stopOutbox.mock.calls[0]?.[0], {
      kind: 'unanswerable'
    })
  })

  it('sends a Stop whose answer was lost again under the same id until it is answered', async () => {
    const outcomes: StructuredAgentSessionWriteOutcome<unknown>[] = [
      { kind: 'not-done', notice: 'Lost.', answered: false },
      { kind: 'not-done', notice: 'Lost.', answered: false },
      DONE
    ]
    const writeAs = vi.fn<StopWrite>(async () => outcomes.shift() ?? DONE)
    const { view, stopOutbox, recordStopAnswer } = harness(writeAs)
    await act(async () => {
      await view.result.current()
    })
    const stopId: string = stopOutbox.mock.calls[0]?.[0]
    // The outbox now holds a send stamped by it, still owed its answer.
    view.rerender({ outbox: [stamped(stopId)] })
    for (let step = 0; step < 10; step += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000)
      })
    }
    // Every attempt is the one Stop, never a new one (the mock outbox keeps the stamp owed).
    expect(writeAs.mock.calls.slice(0, 3).map((call) => call[0])).toEqual([stopId, stopId, stopId])
    expect(new Set(writeAs.mock.calls.map((call) => call[0]))).toEqual(new Set([stopId]))
    expect(recordStopAnswer).toHaveBeenCalledWith(stopId, {
      kind: 'answered',
      cursor: { epoch: 'e', sequence: 9 }
    })
  })

  it('never sends a lost Stop again once a newer message exists: its stamp is given up', async () => {
    const writeAs = vi.fn<StopWrite>(async () => ({
      kind: 'not-done',
      notice: 'Lost.',
      answered: false
    }))
    const { view, stopOutbox, recordStopAnswer } = harness(writeAs)
    await act(async () => {
      await view.result.current()
    })
    const stopId: string = stopOutbox.mock.calls[0]?.[0]
    const newer = {
      ...createStructuredAgentSessionOutboxEntry({
        clientMessageId: createStructuredAgentSessionOperationId(
          createBrowserUuid,
          Date.now() + 1_000
        ),
        sessionId: 'session-1',
        text: 'newer',
        attachments: [],
        queuedAt: Date.now() + 1
      })
    }
    view.rerender({ outbox: [stamped(stopId), newer] })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(writeAs).toHaveBeenCalledOnce()
    expect(recordStopAnswer).toHaveBeenCalledWith(stopId, { kind: 'unanswerable' })
  })

  it('gives the stamp up too for a newer message another client sent, seen in the journal', async () => {
    const writeAs = vi.fn<StopWrite>(async () => ({
      kind: 'not-done',
      notice: 'Lost.',
      answered: false
    }))
    const { view, stopOutbox, recordStopAnswer } = harness(writeAs)
    await act(async () => {
      await view.result.current()
    })
    const stopId: string = stopOutbox.mock.calls[0]?.[0]
    const elsewhere: AgentJournalSubmission = {
      clientMessageId: createStructuredAgentSessionOperationId(
        createBrowserUuid,
        Date.now() + 1_000
      ),
      fence: 1,
      payloadFingerprint: 'fp',
      dispatchState: 'pending',
      providerItemId: null,
      reason: null,
      submittedAt: 1,
      resolvedAt: null
    }
    view.rerender({ outbox: [stamped(stopId)], submissions: [elsewhere] })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(writeAs).toHaveBeenCalledOnce()
    expect(recordStopAnswer).toHaveBeenCalledWith(stopId, { kind: 'unanswerable' })
  })
})
