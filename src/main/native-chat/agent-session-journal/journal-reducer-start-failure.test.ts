// A `pending` dispatch row that records a failed start puts its message back in the queue, and the
// reducer counts the attempts from those rows; nothing else stores the count.

import { describe, expect, it } from 'vitest'
import { isQueuedAgentJournalSubmission } from '../../../shared/agent-session-queued-submission'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import {
  applyJournalRow,
  createJournalReducerState,
  type JournalReducerState
} from './journal-reducer'
import { parseJournalRow, type JournalRow } from './journal-row-schema'

const EPOCH = 'epoch-1'

function base(seq: number): { v: number; epoch: string; seq: number; fence: number; ts: number } {
  return { v: 1, epoch: EPOCH, seq, fence: 1, ts: 1_000 + seq }
}

function fold(rows: JournalRow[]): JournalReducerState {
  const state = createJournalReducerState('session-1', EPOCH)
  for (const row of rows) {
    applyJournalRow(state, row)
  }
  return state
}

const accepted: JournalRow = {
  kind: 'submission',
  clientMessageId: 'cm_1',
  payloadFingerprint: 'fp_1',
  providerHandle: { kind: 'codex', threadId: 'thread-1' },
  body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hi' }] },
  handoverRecorded: true,
  ...base(1)
}

/** A row as it is read back from disk, so a newer or a damaged writer's shape reaches the fold. */
function fromDisk(row: Record<string, unknown>): JournalRow {
  const parsed = parseJournalRow(JSON.stringify(row))
  if (!parsed.ok) {
    throw new Error('the row did not parse')
  }
  return parsed.row
}

function failedStart(seq: number, startFailure: unknown): JournalRow {
  return fromDisk({
    kind: 'dispatch',
    clientMessageId: 'cm_1',
    state: 'pending',
    providerItemId: null,
    reason: null,
    startFailure,
    ...base(seq)
  })
}

const RECORD = {
  reason: "Codex couldn't start. Send your message to try again.",
  rejection: { kind: 'startFailed' },
  generation: 'generation-2',
  nextAttemptAt: 20_000
}

describe('a failed start recorded on its message', () => {
  it('puts a handed-over message back in the queue and counts each failed start', () => {
    const handedOver: JournalRow = {
      kind: 'dispatch',
      clientMessageId: 'cm_1',
      state: 'pending',
      providerItemId: null,
      reason: null,
      turnScope: AGENT_JOURNAL_THREAD_SCOPE,
      ...base(2)
    }
    const state = fold([
      accepted,
      handedOver,
      failedStart(3, RECORD),
      failedStart(4, { ...RECORD, nextAttemptAt: 80_000 })
    ])

    const submission = state.submissions.get('cm_1')!
    expect(isQueuedAgentJournalSubmission(submission)).toBe(true)
    expect(submission.startFailure).toEqual({
      attempts: 2,
      reason: RECORD.reason,
      rejection: { kind: 'startFailed' },
      generation: 'generation-2',
      failedAt: 1_004,
      nextAttemptAt: 80_000
    })
  })

  it('clears the record when the message is handed over again, or ends', () => {
    const handedOver = fold([
      accepted,
      failedStart(2, RECORD),
      {
        kind: 'dispatch',
        clientMessageId: 'cm_1',
        state: 'pending',
        providerItemId: null,
        reason: null,
        turnScope: AGENT_JOURNAL_THREAD_SCOPE,
        ...base(3)
      }
    ]).submissions.get('cm_1')!
    expect(handedOver.startFailure).toBeUndefined()
    expect(handedOver.handedOverAt).toBe(1_003)

    const rejected = fold([
      accepted,
      failedStart(2, RECORD),
      {
        kind: 'dispatch',
        clientMessageId: 'cm_1',
        state: 'rejected',
        providerItemId: null,
        reason: RECORD.reason,
        rejection: { kind: 'startFailed' },
        ...base(3)
      }
    ]).submissions.get('cm_1')!
    expect(rejected).toMatchObject({ dispatchState: 'rejected', reason: RECORD.reason })
    expect(rejected.startFailure).toBeUndefined()
  })

  // A child that never proved its start took nothing it was handed, so no reader may read the
  // message as possibly written, as one rejected after its handover otherwise reads.
  it('reads a message its failed start rejected after its handover as never handed over', () => {
    const handedThenRejected = (rejection: { kind: string }) =>
      fold([
        accepted,
        {
          kind: 'dispatch',
          clientMessageId: 'cm_1',
          state: 'pending',
          providerItemId: null,
          reason: null,
          turnScope: AGENT_JOURNAL_THREAD_SCOPE,
          ...base(2)
        },
        fromDisk({
          kind: 'dispatch',
          clientMessageId: 'cm_1',
          state: 'rejected',
          providerItemId: null,
          reason: 'Written by the host.',
          rejection,
          ...base(3)
        })
      ]).submissions.get('cm_1')!

    expect(handedThenRejected({ kind: 'providerStartFailed' }).handedOverAt).toBeUndefined()
    expect(handedThenRejected({ kind: 'hostStopped' }).handedOverAt).toBeUndefined()
    // The provider refusing what it was handed is no failed start: it was handed over.
    expect(handedThenRejected({ kind: 'providerRejected' }).handedOverAt).toBe(1_002)
  })

  it('reads a malformed record as a plain handover: in doubt at the next open, never failed', () => {
    const submission = fold([
      accepted,
      failedStart(2, { reason: 'no fact', nextAttemptAt: 'soon' })
    ]).submissions.get('cm_1')!

    expect(submission.startFailure).toBeUndefined()
    expect(submission.handedOverAt).toBe(1_002)
    expect(isQueuedAgentJournalSubmission(submission)).toBe(false)
  })

  it('ignores the start key a development build of an earlier design wrote on a rejection', () => {
    const rejected = fromDisk({
      kind: 'dispatch',
      clientMessageId: 'cm_1',
      state: 'rejected',
      providerItemId: null,
      reason: RECORD.reason,
      rejection: { kind: 'startFailed' },
      rejectedByStartKey: 'generation-2',
      ...base(2)
    })

    const submission = fold([accepted, rejected]).submissions.get('cm_1')!

    expect(submission).toMatchObject({ dispatchState: 'rejected', reason: RECORD.reason })
    expect(submission).not.toHaveProperty('rejectedByStartKey')
  })
})
