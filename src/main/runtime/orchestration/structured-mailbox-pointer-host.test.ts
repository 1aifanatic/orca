import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalRenderItem } from '../../../shared/agent-session-journal-types'
import type { AgentMessageSource } from '../../../shared/agent-session-message-source'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'

const hostRef: { current: unknown } = { current: null }

vi.mock('../../native-chat/agent-session-wire/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => hostRef.current
}))

const {
  createStructuredMailboxPointerHost,
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

const NOTICE_SOURCE: AgentMessageSource = {
  kind: 'agent',
  senders: [],
  orchestration: { message: 'mail-notice', mailbox: 'dispatch:d1', dispatchId: 'd1', messages: [] }
}

describe('structured mailbox pointer host', () => {
  beforeEach(() => {
    hostRef.current = null
  })

  it('reads the gate facts from the FULL timeline, never a bounded tail', async () => {
    // The defect this pins: a running turn is announced by ONE lifecycle item, and settlement
    // tombstones it rather than rewriting it. A long tool-calling turn pushes that item arbitrarily
    // far from the tail, so any page-sized read reports a busy worker as idle — and `@idle` then
    // wakes it mid-turn.
    const items = [runningTurn(), ...transcript(500)]
    hostRef.current = { journalSnapshot: () => ({ items, submissions: [] }) }
    expect(await readStructuredSessionGateFacts('s1')).toEqual({
      turnRunning: true,
      awaitingHuman: false
    })
  })

  it("reads what the session's sends settled as", async () => {
    const submissions = [{ clientMessageId: 'op1', dispatchState: 'unknown' }]
    hostRef.current = { journalSnapshot: () => ({ items: [], submissions }) }
    expect(await createStructuredMailboxPointerHost().readSessionFacts('s1')).toEqual({
      submissions
    })
  })

  it.each(['pending', 'accepted'] as const)(
    'projects original mailbox members from the %s submission body',
    async (dispatchState) => {
      const submissions = [{ clientMessageId: 'op1', dispatchState, submittedAt: 1 }]
      const item: AgentJournalRenderItem = {
        itemId: agentJournalSubmissionKey('op1'),
        revision: 1,
        sequence: 1,
        observedAt: 1,
        body: {
          kind: 'message',
          role: 'user',
          blocks: [],
          from: {
            ...NOTICE_SOURCE,
            orchestration: {
              message: 'mail-notice',
              mailbox: 'dispatch:d1',
              dispatchId: 'd1',
              messages: [
                { messageId: 'm1', runId: 'r1', from: 'term_coord' },
                { messageId: 'm2', runId: 'r1', from: 'term_coord' }
              ]
            }
          }
        }
      }
      hostRef.current = { journalSnapshot: () => ({ items: [item], submissions }) }
      expect(await createStructuredMailboxPointerHost().readSessionFacts('s1')).toEqual({
        submissions: [
          {
            ...submissions[0],
            mailNotice: { mailbox: 'dispatch:d1', messageIds: ['m1', 'm2'] }
          }
        ]
      })
    }
  )

  it.each(['completed', 'interrupted', 'running', 'unverifiable'] as const)(
    'derives legacy operation settlement from its own %s turn',
    async (state) => {
      const submission = { clientMessageId: 'op1', dispatchState: 'accepted', submittedAt: 1 }
      const turn: AgentJournalRenderItem = {
        itemId: 'turn-item-1',
        revision: 1,
        sequence: 2,
        observedAt: 2,
        body: {
          kind: 'turn',
          turnId: 'turn-1',
          state,
          userItemId: agentJournalSubmissionKey('op1')
        }
      }
      hostRef.current = { journalSnapshot: () => ({ items: [turn], submissions: [submission] }) }
      expect(await createStructuredMailboxPointerHost().readSessionFacts('s1')).toEqual({
        submissions: [
          {
            ...submission,
            ...(['completed', 'interrupted'].includes(state) ? { turnSettled: true } : {})
          }
        ]
      })
    }
  )

  it('does not treat an unrelated settled turn as the original operation settling', async () => {
    const submission = { clientMessageId: 'op1', dispatchState: 'accepted', submittedAt: 1 }
    const turn: AgentJournalRenderItem = {
      itemId: 'unrelated-turn',
      revision: 1,
      sequence: 2,
      observedAt: 2,
      body: { kind: 'turn', turnId: 'turn-2', state: 'completed', userItemId: 'another-send' }
    }
    hostRef.current = { journalSnapshot: () => ({ items: [turn], submissions: [submission] }) }
    expect(await createStructuredMailboxPointerHost().readSessionFacts('s1')).toEqual({
      submissions: [submission]
    })
  })

  it('reads legacy settlement through a send`s explicit turn scope', async () => {
    const submission = { clientMessageId: 'op1', dispatchState: 'accepted', submittedAt: 1 }
    const items: AgentJournalRenderItem[] = [
      {
        itemId: agentJournalSubmissionKey('op1'),
        revision: 1,
        sequence: 1,
        observedAt: 1,
        turnScope: { kind: 'turn', turnItemId: 'turn-item-1' },
        body: { kind: 'message', role: 'user', blocks: [] }
      },
      {
        itemId: 'turn-item-1',
        revision: 1,
        sequence: 2,
        observedAt: 2,
        body: { kind: 'turn', turnId: 'turn-1', state: 'completed' }
      }
    ]
    hostRef.current = { journalSnapshot: () => ({ items, submissions: [submission] }) }
    expect(await createStructuredMailboxPointerHost().readSessionFacts('s1')).toEqual({
      submissions: [{ ...submission, turnSettled: true }]
    })
  })

  it('answers null rather than nothing recorded when the session cannot be read', async () => {
    // Null retains the pointer; an empty answer would send into a session this runtime cannot see.
    expect(await createStructuredMailboxPointerHost().readSessionFacts('s1')).toBeNull()
    hostRef.current = {
      journalSnapshot: () => {
        throw new Error('agent_session_ownership_unknown')
      }
    }
    expect(await createStructuredMailboxPointerHost().readSessionFacts('s1')).toBeNull()
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

  it('asks a busy chat to queue the pointer as a card, with who it is from', async () => {
    const send = vi.fn(
      async (_caller: unknown, _payload: { delivery?: string; body?: unknown }) => ({
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
        body: { kind: 'message', role: 'user', blocks: [], from: NOTICE_SOURCE }
      })
    ).resolves.toEqual({ kind: 'queued' })
    expect(send.mock.calls[0]![1]).toMatchObject({
      delivery: 'queue-if-active',
      body: { from: NOTICE_SOURCE }
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
      ['agent_session_conflict', { kind: 'sent', state: 'rejected' }]
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
