// @vitest-environment happy-dom
// A composer's saved draft keeps a sent message until the host has it. "Has it" is the host's ok
// reply to the send (pending, accepted or queued), not the provider's acceptance; a refusal, a
// rejection or a send dropped unconfirmed keeps the draft copy, and a new id is followed.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentSessionMutationResult,
  AgentSessionSendResult
} from '../../../../shared/agent-session-wire'
import type {
  AgentJournalDispatchState,
  AgentJournalSubmission
} from '../../../../shared/agent-session-journal-types'
import type { StructuredAgentSessionOutboxEntry } from '../../../../shared/structured-agent-session-outbox'
import { refuseUnclassified } from '../../../../shared/agent-session-wire-refusals'

const reply = vi.hoisted(() => ({ call: vi.fn() }))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: reply.call
}))

import { dispatchStructuredAgentSessionOutboxEntry } from './structured-agent-session-outbox-dispatch'
import {
  appendStructuredAgentSessionOutboxMessage,
  commitStructuredAgentSessionOutbox,
  getStructuredAgentSessionOutbox
} from './structured-agent-session-outbox-storage'
import {
  noteStructuredAgentSessionMessagesDelivered,
  whenStructuredAgentSessionHostHasMessages
} from './structured-agent-session-message-delivery'

const SESSION = 'session-delivery'

function submission(
  clientMessageId: string,
  dispatchState: AgentJournalDispatchState,
  overrides: Partial<AgentJournalSubmission> = {}
): AgentJournalSubmission {
  return {
    clientMessageId,
    fence: 1,
    payloadFingerprint: 'fingerprint',
    dispatchState,
    providerItemId: null,
    reason: null,
    submittedAt: 1,
    resolvedAt: null,
    ...overrides
  }
}

function ok(value: AgentSessionSendResult): AgentSessionMutationResult<AgentSessionSendResult> {
  return { ok: true, replayed: false, fence: 1, cursor: { epoch: 'epoch', sequence: 1 }, value }
}

async function sendWithReply(
  answer: (
    entry: StructuredAgentSessionOutboxEntry
  ) => AgentSessionMutationResult<AgentSessionSendResult>,
  prepare: (entry: StructuredAgentSessionOutboxEntry) => StructuredAgentSessionOutboxEntry = (
    entry
  ) => entry
): Promise<() => boolean> {
  const appended = appendStructuredAgentSessionOutboxMessage(SESSION, 'hello')
  if (!appended) {
    throw new Error('outbox append failed')
  }
  const entry = prepare(appended)
  commitStructuredAgentSessionOutbox(SESSION, [entry])
  let settled = false
  void whenStructuredAgentSessionHostHasMessages(SESSION, [entry]).then(() => {
    settled = true
  })
  reply.call.mockResolvedValueOnce(answer(entry))
  const dispatch = dispatchStructuredAgentSessionOutboxEntry({
    next: entry,
    entries: getStructuredAgentSessionOutbox(SESSION),
    sessionId: SESSION,
    target: { kind: 'local' },
    fence: 1,
    dispatchGeneration: 0,
    dispatchGenerationRef: { current: 0 },
    inFlightIdRef: { current: null },
    setError: () => {},
    applyDisposition: (disposition) => {
      commitStructuredAgentSessionOutbox(SESSION, disposition.entries)
    },
    createOperationId: () => 'rotated-id'
  })
  await dispatch.promise
  await Promise.resolve()
  return () => settled
}

beforeEach(() => {
  localStorage.clear()
  commitStructuredAgentSessionOutbox(SESSION, [])
})

afterEach(() => {
  reply.call.mockReset()
})

describe("a sent message's saved draft", () => {
  it.each([
    ['an accepted', 'accepted', {}],
    ['a handed-over pending', 'pending', { handoverRecorded: true, handedOverAt: 5 }],
    ["an older host's pending", 'pending', {}]
  ] as const)('is released by %s reply', async (_label, state, overrides) => {
    const hostHasIt = await sendWithReply((entry) =>
      ok({
        clientMessageId: entry.clientMessageId,
        submission: submission(entry.clientMessageId, state, overrides)
      })
    )

    expect(hostHasIt()).toBe(true)
  })

  // Accepted but not handed over yet: the host rejects it when Orca quits, and after a crash when
  // the chat next opens, so the saved draft must keep it until the handover.
  it('is kept for a pending reply the host has not handed over yet, until the handover', async () => {
    const hostHasIt = await sendWithReply((entry) =>
      ok({
        clientMessageId: entry.clientMessageId,
        submission: submission(entry.clientMessageId, 'pending', { handoverRecorded: true })
      })
    )
    expect(hostHasIt()).toBe(false)

    const [entry] = getStructuredAgentSessionOutbox(SESSION)
    noteStructuredAgentSessionMessagesDelivered(SESSION, [entry.clientMessageId])
    await Promise.resolve()
    expect(hostHasIt()).toBe(true)
  })

  it('is released by a queued reply', async () => {
    const hostHasIt = await sendWithReply((entry) =>
      ok({
        clientMessageId: entry.clientMessageId,
        queued: { messageId: 'queued-1', position: 1, state: 'waiting' }
      })
    )

    expect(hostHasIt()).toBe(true)
  })

  it('is kept for a rejected message, which stays for Retry', async () => {
    const hostHasIt = await sendWithReply((entry) =>
      ok({
        clientMessageId: entry.clientMessageId,
        submission: submission(entry.clientMessageId, 'rejected', { reason: 'no' })
      })
    )

    expect(hostHasIt()).toBe(false)
  })

  it('follows a refusal that gave the message a new id, and is released once that one lands', async () => {
    const hostHasIt = await sendWithReply(() => ({
      ok: false,
      refusal: refuseUnclassified('agent_session_owner_restart_failed', 'restart failed')
    }))
    expect(getStructuredAgentSessionOutbox(SESSION).map((entry) => entry.clientMessageId)).toEqual([
      'rotated-id'
    ])
    expect(hostHasIt()).toBe(false)

    noteStructuredAgentSessionMessagesDelivered(SESSION, ['rotated-id'])
    await Promise.resolve()
    expect(hostHasIt()).toBe(true)
  })

  it('is kept for a send the host dropped with its delivery unconfirmed', async () => {
    const hostHasIt = await sendWithReply(
      (entry) =>
        ok({
          clientMessageId: entry.clientMessageId,
          submission: submission(entry.clientMessageId, 'unknown', { submittedAt: 7 })
        }),
      (entry) => ({ ...entry, state: 'unconfirmed', retryAfterUnknownSubmittedAt: 7 })
    )

    expect(getStructuredAgentSessionOutbox(SESSION)).toEqual([])
    expect(hostHasIt()).toBe(false)
  })
})
