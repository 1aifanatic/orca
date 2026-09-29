import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalRenderItem } from '../../../shared/agent-session-journal-types'
import { ORCHESTRATION_READINESS_TIMEOUT_MS } from '../../../shared/orchestration-timing-budgets'
import { DISPATCH_DOUBT_PROVIDER_EXITED } from '../../native-chat/agent-session-journal/journal-dispatch-doubt-reasons'
import {
  AGENT_SESSION_FAILURE_KINDS,
  type AgentSessionFailureKind
} from '../../../shared/agent-session-failure'

const hostRef: { current: unknown } = { current: null }

vi.mock('../../native-chat/agent-session-wire/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => hostRef.current
}))

const {
  createStructuredMailboxPointerHost,
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

describe('structured mailbox pointer host', () => {
  beforeEach(() => {
    hostRef.current = null
  })

  it('reads the gate facts from the FULL timeline, never a bounded tail', async () => {
    // The defect this pins: a running turn is announced by ONE lifecycle item, and settlement
    // tombstones it rather than rewriting it. A long tool-calling turn pushes that item arbitrarily
    // far from the tail, so any page-sized read reports a busy worker as idle — and the pointer is
    // then delivered mid-turn, which Codex coalesces into the running turn and Claude folds into
    // it -- either way folded into work already in flight rather than read as a new instruction.
    const items = [runningTurn(), ...transcript(500)]
    hostRef.current = { journalSnapshot: () => ({ items, submissions: [] }) }
    expect(await createStructuredMailboxPointerHost().readGateFacts('s1')).toEqual({
      turnRunning: true,
      awaitingHuman: false,
      latestSendHoldsMail: false
    })
  })

  // Every failure kind, held or delivered; a new kind fails to compile here until it is placed.
  const HELD_AFTER_REJECTION = {
    providerExited: true,
    providerStartFailed: true,
    startFailed: true,
    restartFailed: true,
    hostStopped: true,
    notSignedIn: true,
    historyTooLarge: true,
    managedAccountEnvOverride: true,
    managedAccountUnsupported: true,
    accountSwitchInProgress: false,
    cancelled: false,
    hostRestarted: false,
    chatClosed: false,
    notDelivered: false,
    providerRejected: false,
    attachmentInvalid: false,
    attachmentUnreadable: false,
    emptyMessage: false,
    queueFull: false,
    writeFailed: false,
    hostFault: false,
    // Status-row kinds: never why a send was rejected, so never a hold.
    compactionFailed: false,
    compactionUnconfirmed: false,
    cancelUnconfirmed: false,
    answerUnconfirmed: false,
    providerRetrying: false
  } satisfies Record<AgentSessionFailureKind, boolean>

  it('places every failure kind', () => {
    expect(Object.keys(HELD_AFTER_REJECTION).sort()).toEqual(
      [...AGENT_SESSION_FAILURE_KINDS].sort()
    )
  })

  it.each(AGENT_SESSION_FAILURE_KINDS.map((kind) => [kind, HELD_AFTER_REJECTION[kind]] as const))(
    'after a latest send rejected as %s, holds the mail: %s',
    async (kind, held) => {
      const earlier = { dispatchState: 'accepted', reason: null }
      const latest = { dispatchState: 'rejected', reason: 'x', rejection: { kind } }
      hostRef.current = { journalSnapshot: () => ({ items: [], submissions: [earlier, latest] }) }
      expect(await createStructuredMailboxPointerHost().readGateFacts('s1')).toMatchObject({
        latestSendHoldsMail: held
      })
    }
  )

  it.each([
    ['its provider exited before echoing it', DISPATCH_DOUBT_PROVIDER_EXITED, true],
    ['a write outcome was lost', 'provider_write_outcome_unknown: gone', false],
    ['Orca closed the agent itself', 'provider_closed_before_acknowledgement', false],
    ['Orca restarted', 'host_restarted_before_acknowledgement', false]
  ] as const)(
    'after a latest send in doubt because %s, holds the mail: %s',
    async (_label, reason, held) => {
      // Only a death holds: pointing again would start that provider again.
      hostRef.current = {
        journalSnapshot: () => ({ items: [], submissions: [{ dispatchState: 'unknown', reason }] })
      }
      expect(await createStructuredMailboxPointerHost().readGateFacts('s1')).toMatchObject({
        latestSendHoldsMail: held
      })
    }
  )

  it('holds nothing after a latest send that ran, or a rejection this build cannot place', async () => {
    for (const latest of [
      { dispatchState: 'accepted', reason: null },
      { dispatchState: 'rejected', reason: 'x', rejection: { kind: 'someFutureKind' } },
      { dispatchState: 'rejected', reason: 'legacy sentence' }
    ]) {
      hostRef.current = { journalSnapshot: () => ({ items: [], submissions: [latest] }) }
      expect(await createStructuredMailboxPointerHost().readGateFacts('s1')).toMatchObject({
        latestSendHoldsMail: false
      })
    }
  })

  it('clears the hold once a later send runs', async () => {
    const died = { dispatchState: 'unknown', reason: DISPATCH_DOUBT_PROVIDER_EXITED }
    const ran = { dispatchState: 'accepted', reason: null }
    hostRef.current = { journalSnapshot: () => ({ items: [], submissions: [died, ran] }) }
    expect(await createStructuredMailboxPointerHost().readGateFacts('s1')).toMatchObject({
      latestSendHoldsMail: false
    })
  })

  it('answers null rather than idle when the session cannot be read', async () => {
    // Null retains the pointer; `{turnRunning:false}` would deliver a nudge into a session this
    // runtime cannot see at all.
    expect(await createStructuredMailboxPointerHost().readGateFacts('s1')).toBeNull()
    hostRef.current = {
      journalSnapshot: () => {
        throw new Error('agent_session_ownership_unknown')
      }
    }
    expect(await createStructuredMailboxPointerHost().readGateFacts('s1')).toBeNull()
  })

  it('reports an unattached host rather than a rejection when nothing can be sent', async () => {
    await expect(
      createStructuredMailboxPointerHost().send({
        sessionId: 's1',
        dispatchId: 'd1',
        operationId: 'op1',
        expectedRuntimeFence: 1,
        payloadFingerprint: 'fp',
        body: { kind: 'message', role: 'user', blocks: [] }
      } as never)
    ).resolves.toEqual({ kind: 'unattached' })
  })

  it.each([
    ['accepted', 'accepted'],
    ['rejected', 'rejected'],
    // A failed or unanswered call: the lane retains for the next journal edge.
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
        payloadFingerprint: 'fp',
        body: { kind: 'message', role: 'user', blocks: [] }
      } as never)
    ).resolves.toEqual({ kind: 'sent', state: expected })
    // Per-dispatch, so one worker's nudges cannot exhaust the shared operation-ledger budget.
    expect(send.mock.calls[0]![0]).toEqual({ callerKey: structuredPointerCallerKey('d1') })
    expect(send.mock.calls[0]![1]!.retryUnknown).toBeUndefined()
  })

  it.each([
    [
      'an echoed turn',
      async () => ({ value: { submission: { dispatchState: 'accepted' } } }),
      'accepted'
    ],
    [
      'a provider that died first',
      async () => ({ value: { submission: { dispatchState: 'unknown' } } }),
      'unknown'
    ],
    ['a wait that gave up', async () => undefined, 'unknown'],
    [
      'a send that disappeared',
      async () => {
        throw new Error('gone')
      },
      'unknown'
    ]
  ] as const)('settles an admitted pointer from %s', async (_label, wait, expected) => {
    // Admitted is only a claim: the lane consumes the rows on `accepted` and gives them back on
    // anything else, so every way the wait can end must reach it as a verdict.
    const waitForSendSettlement = vi.fn(wait)
    hostRef.current = {
      send: async () => ({
        ok: true,
        value: { clientMessageId: 'op1', submission: { dispatchState: 'pending' } }
      }),
      waitForSendSettlement
    }
    const outcome = await createStructuredMailboxPointerHost().send({
      sessionId: 's1',
      dispatchId: 'd1',
      operationId: 'op1',
      expectedRuntimeFence: 1,
      payloadFingerprint: 'fp',
      body: { kind: 'message', role: 'user', blocks: [] }
    })
    expect(outcome).toMatchObject({ kind: 'sent', state: 'pending' })
    await expect(
      outcome.kind === 'sent' && outcome.state === 'pending' ? outcome.settlement : null
    ).resolves.toBe(expected)
    expect(waitForSendSettlement).toHaveBeenCalledWith('s1', 'op1', {
      budgetMs: ORCHESTRATION_READINESS_TIMEOUT_MS
    })
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
        payloadFingerprint: 'fp',
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
          payloadFingerprint: 'fp',
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
