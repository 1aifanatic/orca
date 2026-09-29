import { describe, expect, it } from 'vitest'
import { AGENT_SESSION_MAX_OPERATION_REPLAY_AGE_MS } from '../../../shared/agent-session-host-authority'
import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import {
  decideStructuredPointerAttempt,
  mintAgentSessionOperationId,
  resolveStructuredPointerOperation,
  type StructuredPointerSubmission
} from './structured-pointer-operation-id'

const OPERATION_ID_PATTERN = /^\d{13}-[0-9a-f]{32}$/

function body(text: string): AgentJournalMessageItem {
  return { kind: 'message', role: 'user', blocks: [{ type: 'text', text }] }
}

/** A send under a fresh row, with nothing recorded yet: the id this batch resolves to. */
function resolveId(
  args: Omit<
    Parameters<typeof resolveStructuredPointerOperation>[0],
    'submissions' | 'laneStartedAtMs'
  >
): {
  operationId: string
  payloadFingerprint: string
} {
  const resolved = resolveStructuredPointerOperation({
    ...args,
    submissions: [],
    laneStartedAtMs: 0
  })
  if (resolved.kind !== 'send') {
    throw new Error(`expected a send, got ${resolved.kind}`)
  }
  return resolved
}

function fakeDb() {
  const rows = new Map<string, { mailbox_handle: string; operation_id: string }>()
  return {
    rows,
    getStructuredPointerOperation: (handle: string) => rows.get(handle),
    putStructuredPointerOperation: (row: { mailbox_handle: string; operation_id: string }) =>
      rows.set(row.mailbox_handle, row)
  } as never
}

describe('structured pointer operation id', () => {
  it('mints ids the host will admit', () => {
    // Orchestration's own msg_<hex> ids do not match and are refused before the first send.
    expect(mintAgentSessionOperationId(Date.now())).toMatch(OPERATION_ID_PATTERN)
  })

  it('reuses one id for the same batch', () => {
    const db = fakeDb()
    const first = resolveId({
      db,
      mailboxHandle: 'dispatch:d1',
      sessionId: 's1',
      body: body('2 messages'),
      messageIds: ['m1', 'm2'],
      now: 1_000
    })
    const second = resolveId({
      db,
      mailboxHandle: 'dispatch:d1',
      sessionId: 's1',
      body: body('2 messages'),
      messageIds: ['m1', 'm2'],
      now: 2_000
    })
    expect(second.operationId).toBe(first.operationId)
    expect(second.payloadFingerprint).toBe(first.payloadFingerprint)
  })

  it('re-mints when the batch grows', () => {
    const db = fakeDb()
    const first = resolveId({
      db,
      mailboxHandle: 'dispatch:d1',
      sessionId: 's1',
      body: body('2 messages'),
      messageIds: ['m1', 'm2'],
      now: 1_000
    })
    const grown = resolveId({
      db,
      mailboxHandle: 'dispatch:d1',
      sessionId: 's1',
      body: body('3 messages'),
      messageIds: ['m1', 'm2', 'm3'],
      now: 1_500
    })
    expect(grown.operationId).not.toBe(first.operationId)
  })

  it('never re-mints an ambiguous batch after the host replay window expires', () => {
    const db = fakeDb()
    const first = resolveId({
      db,
      mailboxHandle: 'dispatch:d1',
      sessionId: 's1',
      body: body('2 messages'),
      messageIds: ['m1', 'm2'],
      now: 1_000
    })
    const aged = resolveId({
      db,
      mailboxHandle: 'dispatch:d1',
      sessionId: 's1',
      body: body('2 messages'),
      messageIds: ['m1', 'm2'],
      now: 1_000 + AGENT_SESSION_MAX_OPERATION_REPLAY_AGE_MS + 1
    })
    expect(aged.operationId).toBe(first.operationId)
  })

  it('re-mints for a different batch of the same size', () => {
    // The pointer body names only how many messages are waiting, so two unrelated same-size
    // batches share a payload fingerprint. Reusing the live id across them makes the host replay
    // its ledger answer — `accepted`, with no turn sent — and the lane then marks the NEW mail
    // delivered. The worker is never told, and the mail is gone.
    const db = fakeDb()
    const first = resolveId({
      db,
      mailboxHandle: 'dispatch:d1',
      sessionId: 's1',
      body: body('2 messages'),
      messageIds: ['m1', 'm2'],
      now: 1_000
    })
    const different = resolveId({
      db,
      mailboxHandle: 'dispatch:d1',
      sessionId: 's1',
      body: body('2 messages'),
      messageIds: ['m3', 'm4'],
      now: 1_100
    })
    expect(different.operationId).not.toBe(first.operationId)
    expect(different.payloadFingerprint).toBe(first.payloadFingerprint)
  })

  it('re-mints when a retained batch is reordered or partly consumed', () => {
    const db = fakeDb()
    const first = resolveId({
      db,
      mailboxHandle: 'dispatch:d1',
      sessionId: 's1',
      body: body('2 messages'),
      messageIds: ['m1', 'm2'],
      now: 1_000
    })
    const shifted = resolveId({
      db,
      mailboxHandle: 'dispatch:d1',
      sessionId: 's1',
      body: body('2 messages'),
      messageIds: ['m2', 'm3'],
      now: 1_100
    })
    expect(shifted.operationId).not.toBe(first.operationId)
  })

  it('re-mints when the mailbox moves to a different session', () => {
    const db = fakeDb()
    const first = resolveId({
      db,
      mailboxHandle: 'dispatch:d1',
      sessionId: 's1',
      body: body('2 messages'),
      messageIds: ['m1', 'm2'],
      now: 1_000
    })
    const moved = resolveId({
      db,
      mailboxHandle: 'dispatch:d1',
      sessionId: 's2',
      body: body('2 messages'),
      messageIds: ['m1', 'm2'],
      now: 1_100
    })
    expect(moved.operationId).not.toBe(first.operationId)
  })
})

describe('what a pointer attempt does with its operation row', () => {
  const row = {
    mailbox_handle: 'run:r1',
    session_id: 's1',
    operation_id: 'op1',
    batch_fingerprint: 'batch-1',
    minted_at_ms: 2_000
  }

  function decide(
    submissions: StructuredPointerSubmission[],
    overrides: { batchFingerprint?: string; laneStartedAtMs?: number; sessionId?: string } = {}
  ) {
    return decideStructuredPointerAttempt({
      row,
      sessionId: overrides.sessionId ?? 's1',
      batchFingerprint: overrides.batchFingerprint ?? 'batch-1',
      submissions,
      laneStartedAtMs: overrides.laneStartedAtMs ?? 1_000
    })
  }

  const sent = (dispatchState: StructuredPointerSubmission['dispatchState'], kind?: string) => ({
    clientMessageId: 'op1',
    dispatchState,
    ...(kind ? { rejection: { kind } } : {})
  })
  const userTurn = (dispatchState: StructuredPointerSubmission['dispatchState']) => ({
    clientMessageId: 'user-1',
    dispatchState
  })

  it('mints for a new batch, a new session, or no row at all', () => {
    expect(decide([], { batchFingerprint: 'batch-2' })).toBe('mint')
    expect(decide([], { sessionId: 's2' })).toBe('mint')
    expect(
      decideStructuredPointerAttempt({
        row: undefined,
        sessionId: 's1',
        batchFingerprint: 'batch-1',
        submissions: [],
        laneStartedAtMs: 0
      })
    ).toBe('mint')
  })

  it('sends under the same id when the host never recorded it', () => {
    expect(decide([userTurn('accepted')])).toBe('reuse')
  })

  it('stamps a send that ran, and parks one still in flight', () => {
    expect(decide([sent('accepted')])).toBe('stamp')
    expect(decide([sent('pending')])).toBe('park')
  })

  it.each([
    ['in doubt', sent('unknown')],
    ['refused to start', sent('rejected', 'notSignedIn')],
    ['stopped by the person', sent('rejected', 'cancelled')]
  ])('replays a send that %s instead of starting the agent again', (_label, failed) => {
    expect(decide([failed])).toBe('reuse')
    // A later send that has not run yet is no evidence the agent works again.
    expect(decide([failed, userTurn('pending')])).toBe('reuse')
  })

  it('mints once a later send ran, since the agent works again', () => {
    expect(decide([sent('unknown'), userTurn('accepted')])).toBe('mint')
    expect(decide([sent('rejected', 'cancelled'), userTurn('accepted')])).toBe('mint')
  })

  it('mints a failed send an earlier process left behind', () => {
    expect(decide([sent('unknown')], { laneStartedAtMs: 3_000 })).toBe('mint')
    expect(decide([sent('rejected', 'hostRestarted')], { laneStartedAtMs: 3_000 })).toBe('mint')
  })

  it('mints after a refusal that ends on its own once an account switch settles', () => {
    expect(decide([sent('rejected', 'accountSwitchInProgress')])).toBe('mint')
  })
})
