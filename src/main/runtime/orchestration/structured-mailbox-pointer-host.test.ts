import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalRenderItem } from '../../../shared/agent-session-journal-types'
import type { AgentMessageSource } from '../../../shared/agent-session-message-source'

const hostRef: { current: unknown } = { current: null }

vi.mock('../../native-chat/agent-session-wire/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => hostRef.current
}))

const {
  createStructuredMailboxPointerHost,
  readStructuredChatMail,
  readStructuredSessionGateFacts,
  structuredPointerCallerKey,
  structuredSessionPointerCallerKey
} = await import('./structured-mailbox-pointer-host')

function runningTurn(): AgentJournalRenderItem {
  return {
    itemId: 'lifecycle-1',
    revision: 1,
    body: { kind: 'status', text: 'working', turnLifecycle: { turnId: 'turn-1', state: 'running' } }
  } as unknown as AgentJournalRenderItem
}

function transcript(count: number): AgentJournalRenderItem[] {
  return Array.from(
    { length: count },
    (_unused, index) =>
      ({
        itemId: `tool-${index}`,
        revision: 1,
        body: { kind: 'tool-call', name: 'Bash', input: {}, state: 'completed' }
      }) as unknown as AgentJournalRenderItem
  )
}

const MAIL_SOURCE: AgentMessageSource = {
  kind: 'agent',
  senders: [],
  orchestration: { message: 'mail', mailbox: 'dispatch:d1', dispatchId: 'd1', messages: [] }
}

describe('structured mailbox pointer host', () => {
  beforeEach(() => {
    hostRef.current = null
  })

  it('reads the gate facts from the FULL timeline, never a bounded tail', async () => {
    // The defect this pins: a running turn is announced by ONE lifecycle item, and settlement
    // tombstones it rather than rewriting it. A long tool-calling turn pushes that item arbitrarily
    // far from the tail, so any page-sized read reports a busy worker as idle — and `@idle` then
    // wakes it mid-turn, which Codex coalesces into the running turn and Claude folds into it.
    const items = [runningTurn(), ...transcript(500)]
    hostRef.current = { journalSnapshot: () => ({ items, submissions: [] }) }
    expect(await readStructuredSessionGateFacts('s1')).toEqual({
      turnRunning: true,
      awaitingHuman: false
    })
  })

  it("reads each agent card's state and each agent send's verdict, with the mail each carries", async () => {
    const mail = (messageIds: string[]) => ({
      kind: 'agent',
      senders: [],
      orchestration: {
        message: 'mail',
        mailbox: 'run:r1',
        dispatchId: null,
        messages: messageIds.map((messageId) => ({ messageId, runId: 'r1', from: 'term_a' }))
      }
    })
    const submission = (clientMessageId: string, dispatchState: string) => ({
      clientMessageId,
      dispatchState,
      submittedAt: 1
    })
    const sends = [
      { submission: submission('typed', 'accepted'), source: undefined },
      { submission: submission('op1', 'unknown'), source: mail(['m1']) },
      { submission: submission('handoff-a', 'accepted'), source: mail(['m2']) },
      {
        submission: submission('task', 'pending'),
        source: { kind: 'agent', senders: [], orchestration: { message: 'unknown' } }
      }
    ]
    const cards = [
      { messageId: 'card-a', state: 'dispatched', settledByOp: null, source: mail(['m2']) },
      {
        messageId: 'card-b',
        state: 'withdrawn',
        settledByOp: 'test-surface\u0000op',
        source: mail(['m3'])
      },
      {
        messageId: 'card-c',
        state: 'withdrawn',
        settledByOp: 'trusted-local:orchestration:mail-card\u0000op',
        source: mail(['m4'])
      },
      { messageId: 'card-d', state: 'returned', settledByOp: null, source: mail(['m5']) },
      { messageId: 'typed-card', state: 'waiting', settledByOp: null, source: { kind: 'user' } }
    ]
    const journal = {
      queuedMessages: { list: () => cards },
      submissions: () => sends.map((each) => each.submission),
      submissionSource: (id: string) =>
        sends.find((each) => each.submission.clientMessageId === id)?.source
    }
    hostRef.current = { conversationJournal: async () => journal }
    const card = (cardId: string, messageIds: string[], state: string) => ({
      cardId,
      mailbox: 'run:r1',
      messageIds,
      state
    })
    expect(await readStructuredChatMail('s1')).toEqual({
      cards: [
        card('card-a', ['m2'], 'dispatched'),
        // Withdrawn by anyone but Orca: the person's Delete, whose mail waits for `check`.
        card('card-b', ['m3'], 'declined'),
        card('card-c', ['m4'], 'withdrawn'),
        card('card-d', ['m5'], 'returned')
      ],
      sends: [
        { mailbox: 'run:r1', messageIds: ['m1'], dispatchState: 'unknown' },
        { mailbox: 'run:r1', messageIds: ['m2'], dispatchState: 'accepted' }
      ],
      submissions: sends.map((each) => each.submission)
    })
  })

  it('answers null rather than nothing recorded when the session cannot be read', async () => {
    // Null retains the pointer; an empty answer would read as "never sent" and send again into a
    // session this runtime cannot see at all.
    expect(await readStructuredChatMail('s1')).toBeNull()
    hostRef.current = {
      conversationJournal: async () => {
        throw new Error('agent_session_ownership_unknown')
      }
    }
    expect(await readStructuredChatMail('s1')).toBeNull()
  })

  it("withdraws only agents' cards, as Orca, under Orca's own caller key", async () => {
    const withdraw = vi.fn(async (input: { messageIds: readonly string[]; settledByOp: string }) =>
      input.messageIds.map((messageId) => ({ messageId }))
    )
    const sources: Record<string, { kind: string }> = { c1: MAIL_SOURCE, typed: { kind: 'user' } }
    hostRef.current = {
      conversationJournal: async () => ({
        queuedMessages: { withdraw, get: (id: string) => ({ source: sources[id] }) }
      })
    }
    expect(await createStructuredMailboxPointerHost().withdrawCards('s1', ['c1', 'typed'])).toEqual(
      ['c1']
    )
    expect(withdraw.mock.calls[0]![0].settledByOp).toMatch(/^trusted-local:orchestration:/)
    hostRef.current = null
    expect(await createStructuredMailboxPointerHost().withdrawCards('s1', ['c1'])).toEqual([])
  })

  it('reports an unattached host rather than a rejection when nothing can be sent', async () => {
    await expect(
      createStructuredMailboxPointerHost().send({
        sessionId: 's1',
        dispatchId: 'd1',
        operationId: 'op1',
        expectedRuntimeFence: 1,
        body: { kind: 'message', role: 'user', blocks: [] }
      } as never)
    ).resolves.toEqual({ kind: 'unattached' })
  })

  it.each([
    ['accepted', 'accepted'],
    ['rejected', 'rejected'],
    // Neither is an acknowledgement, and only `accepted` may consume mail: both have to reach the
    // caller as `unknown` so the pointer is retained for the next journal edge.
    ['pending', 'unknown'],
    ['unknown', 'unknown']
  ])('maps a %s submission to %s', async (dispatchState, expected) => {
    const send = vi.fn(
      async (_caller: { callerKey: string }, _payload: { retryUnknown?: boolean }) => ({
        ok: true,
        value: { submission: { dispatchState } }
      })
    )
    hostRef.current = { send, waitForSendSettlement: async () => undefined }
    await expect(
      createStructuredMailboxPointerHost().send({
        sessionId: 's1',
        dispatchId: 'd1',
        operationId: 'op1',
        expectedRuntimeFence: 1,
        body: { kind: 'message', role: 'user', blocks: [] }
      } as never)
    ).resolves.toEqual({ kind: 'sent', state: expected })
    // Per-dispatch, so one worker's nudges cannot exhaust the shared operation-ledger budget.
    expect(send.mock.calls[0]![0]).toEqual({ callerKey: structuredPointerCallerKey('d1') })
    expect(send.mock.calls[0]![1]!.retryUnknown).toBeUndefined()
  })

  it('asks a busy chat to queue the turn as a card, with who it is from', async () => {
    const send = vi.fn(
      async (_caller: unknown, _payload: { delivery?: string; source?: unknown }) => ({
        ok: true,
        value: {
          clientMessageId: 'op1',
          queued: { messageId: 'op1', position: 0, state: 'waiting' }
        }
      })
    )
    hostRef.current = { send }
    await expect(
      createStructuredMailboxPointerHost().send({
        sessionId: 's1',
        dispatchId: 'd1',
        operationId: 'op1',
        expectedRuntimeFence: 1,
        body: { kind: 'message', role: 'user', blocks: [] },
        source: MAIL_SOURCE
      })
    ).resolves.toEqual({ kind: 'queued' })
    expect(send.mock.calls[0]![1]).toMatchObject({
      delivery: 'queue-if-active',
      source: MAIL_SOURCE
    })
  })

  it('consumes mail once an accepted nudge is delivered while the worker starts (W10)', async () => {
    hostRef.current = {
      send: async () => ({
        ok: true,
        value: { clientMessageId: 'op1', submission: { dispatchState: 'pending' } }
      }),
      waitForSendSettlement: async () => ({
        value: { clientMessageId: 'op1', submission: { dispatchState: 'accepted' } }
      })
    }
    await expect(
      createStructuredMailboxPointerHost().send({
        sessionId: 's1',
        dispatchId: 'd1',
        operationId: 'op1',
        expectedRuntimeFence: 1,
        body: { kind: 'message', role: 'user', blocks: [] }
      } as never)
    ).resolves.toEqual({ kind: 'sent', state: 'accepted' })
  })

  it('scopes direct peer mail to the session when there is no dispatch to scope to', async () => {
    // Direct mail is addressed to the worker's own handle, so there may be no dispatch at all.
    // The ledger is keyed on (callerKey, operationId): a key derived from the session keeps that
    // nudge's own retry lane, and leaves the dispatch key byte-identical so nudges already in
    // flight under it still replay rather than being re-minted as a second turn.
    const send = vi.fn(async (_caller: { callerKey: string }) => ({
      ok: true,
      value: { submission: { dispatchState: 'accepted' } }
    }))
    hostRef.current = { send }
    await expect(
      createStructuredMailboxPointerHost().send({
        sessionId: 's1',
        dispatchId: null,
        operationId: 'op1',
        expectedRuntimeFence: 1,
        body: { kind: 'message', role: 'user', blocks: [] }
      } as never)
    ).resolves.toEqual({ kind: 'sent', state: 'accepted' })
    expect(send.mock.calls[0]![0]).toEqual({
      callerKey: structuredSessionPointerCallerKey('s1')
    })
    expect(structuredSessionPointerCallerKey('s1')).not.toBe(structuredPointerCallerKey('s1'))
  })

  it('separates a not-attached refusal from a real one', async () => {
    for (const [code, expected] of [
      ['agent_session_ownership_unknown', { kind: 'unattached' }],
      // Refused before anything started: nothing for a retry under the same id to replay.
      ['agent_session_conflict', { kind: 'refused' }]
    ] as const) {
      hostRef.current = { send: async () => ({ ok: false, refusal: { code, message: 'no' } }) }
      await expect(
        createStructuredMailboxPointerHost().send({
          sessionId: 's1',
          dispatchId: 'd1',
          operationId: 'op1',
          expectedRuntimeFence: 1,
          body: { kind: 'message', role: 'user', blocks: [] }
        } as never)
      ).resolves.toEqual(expected)
    }
  })

  it('reads the runtime fence off the durable record', () => {
    hostRef.current = { deps: { store: { getRecord: () => ({ lease: { runtimeFence: 9 } }) } } }
    expect(createStructuredMailboxPointerHost().currentFence('s1')).toBe(9)
    hostRef.current = { deps: { store: { getRecord: () => null } } }
    expect(createStructuredMailboxPointerHost().currentFence('s1')).toBeNull()
  })
})
