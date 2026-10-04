// @vitest-environment happy-dom

// The outbox re-reads the journal on every batch; a batch that settles nothing writes nothing, so a
// message left in doubt, or one the host rejected whose row is not loaded, costs no storage write
// per streamed delta.

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session-journal-types'
import { createStructuredAgentSessionOutboxEntry } from '../../../../shared/structured-agent-session-outbox'

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: vi.fn(() => new Promise(() => {}))
}))

import { writeOutbox } from './structured-agent-session-outbox-storage'
import { useStructuredAgentSessionOutbox } from './use-structured-agent-session-outbox'

afterEach(cleanup)

beforeEach(() => {
  localStorage.clear()
})

const SESSION = 'session-churn'
// One target across renders: a new one reads as an owner change, which sends again.
const LOCAL = { kind: 'local' as const }

function stored(
  id: string,
  patch: Partial<ReturnType<typeof createStructuredAgentSessionOutboxEntry>>
) {
  return {
    ...createStructuredAgentSessionOutboxEntry({
      clientMessageId: id,
      sessionId: SESSION,
      text: id,
      attachments: [],
      queuedAt: 1
    }),
    ...patch
  }
}

function inDoubt(clientMessageId: string): AgentJournalSubmission {
  return {
    clientMessageId,
    fence: 1,
    payloadFingerprint: clientMessageId,
    dispatchState: 'unknown',
    providerItemId: null,
    reason: 'in doubt',
    submittedAt: 5,
    resolvedAt: 6
  }
}

function streamed(sequence: number): AgentJournalRenderItem[] {
  return [
    {
      itemId: `answer-${sequence}`,
      revision: sequence,
      sequence,
      observedAt: sequence,
      body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'streaming' }] }
    }
  ]
}

it('writes nothing to storage across 50 batches while a message waits in doubt', async () => {
  writeOutbox(SESSION, [stored('doubt', { state: 'dispatching', lastAttemptAt: 2 })])
  const { rerender } = renderHook(
    (props: { items: AgentJournalRenderItem[]; submissions: AgentJournalSubmission[] }) =>
      useStructuredAgentSessionOutbox({
        sessionId: SESSION,
        target: LOCAL,
        fence: 1,
        submissions: props.submissions,
        journalItems: props.items
      }),
    { initialProps: { items: streamed(1), submissions: [inDoubt('doubt')] } }
  )
  await act(async () => {})
  const writes = vi.spyOn(localStorage, 'setItem')

  for (let sequence = 2; sequence <= 51; sequence += 1) {
    // Each batch is a new journal array and a new submissions array with the same content.
    rerender({ items: streamed(sequence), submissions: [inDoubt('doubt')] })
  }
  await act(async () => {})

  expect(writes).not.toHaveBeenCalled()
  writes.mockRestore()
})

function rejected(clientMessageId: string): AgentJournalSubmission {
  return {
    ...inDoubt(clientMessageId),
    dispatchState: 'rejected',
    reason: 'Orca restarted before this message was sent.',
    rejection: { kind: 'hostRestarted' }
  }
}

it("writes nothing across 50 batches while a rejected message's row is not loaded", async () => {
  writeOutbox(SESSION, [stored('rejected', { state: 'unconfirmed', lastAttemptAt: 2 })])
  const { result, rerender } = renderHook(
    (props: { items: AgentJournalRenderItem[]; submissions: AgentJournalSubmission[] }) =>
      useStructuredAgentSessionOutbox({
        sessionId: SESSION,
        target: LOCAL,
        fence: 1,
        submissions: props.submissions,
        journalItems: props.items
      }),
    { initialProps: { items: streamed(1), submissions: [rejected('rejected')] } }
  )
  await act(async () => {})
  // Settled once: no longer sent again, and it draws the message until its row loads.
  expect(result.current.outbox).toMatchObject([
    { clientMessageId: 'rejected', state: 'dispatching' }
  ])
  const writes = vi.spyOn(localStorage, 'setItem')

  for (let sequence = 2; sequence <= 51; sequence += 1) {
    rerender({ items: streamed(sequence), submissions: [rejected('rejected')] })
  }
  await act(async () => {})

  expect(writes).not.toHaveBeenCalled()
  writes.mockRestore()
  expect(result.current.outbox).toHaveLength(1)
})
