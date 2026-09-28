// A dispatch row's typed rejection fact, as the reducer folds it onto the submission.

import { describe, expect, it } from 'vitest'
import {
  classifyDispatchRejection,
  DISPATCH_REJECTED_QUEUE_FULL
} from '../../../shared/structured-agent-session-dispatch-rejection'
import {
  applyJournalRow,
  createJournalReducerState,
  type JournalReducerState
} from './journal-reducer'
import { parseJournalRow, serializeJournalRow, type JournalRow } from './journal-row-schema'

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

describe('a rejected dispatch', () => {
  const submission: JournalRow = {
    kind: 'submission',
    clientMessageId: 'cm_1',
    payloadFingerprint: 'fp_1',
    providerHandle: { kind: 'codex', threadId: 'thread-1' },
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hi' }] },
    ...base(1)
  }

  it("copies a rejection's typed fact onto the submission, and only on `rejected`", () => {
    const rejection = { kind: 'providerRejected', detail: { text: 'Too long', audience: 'person' } }
    const state = fold([
      submission,
      {
        kind: 'dispatch',
        clientMessageId: 'cm_1',
        state: 'rejected',
        providerItemId: null,
        reason: 'The provider did not accept this message.',
        rejection: { kind: 'providerRejected', detail: { text: 'Too long', audience: 'person' } },
        ...base(2)
      }
    ])
    expect(state.submissions.get('cm_1')).toMatchObject({
      dispatchState: 'rejected',
      reason: 'The provider did not accept this message.',
      rejection
    })

    const doubt = fold([
      { ...submission, clientMessageId: 'cm_2' },
      {
        kind: 'dispatch',
        clientMessageId: 'cm_2',
        state: 'unknown',
        providerItemId: null,
        reason: 'provider_exited_before_acknowledgement',
        rejection: { kind: 'writeFailed' },
        ...base(2)
      }
    ])
    expect(doubt.submissions.get('cm_2')).not.toHaveProperty('rejection')
  })

  it('keeps only the kind of a rejection fact it cannot place, so it reads as no verdict', () => {
    const rejected = (rejection: unknown): JournalRow => {
      const row: JournalRow = {
        kind: 'dispatch',
        clientMessageId: 'cm_1',
        state: 'rejected',
        providerItemId: null,
        reason: DISPATCH_REJECTED_QUEUE_FULL,
        ...base(2)
      }
      // A row read from disk carries whatever the host that wrote it did.
      return Object.assign(row, { rejection })
    }
    // A newer host's kind: the marker beside it must not decide.
    const newer = fold([submission, rejected({ kind: 'futureKind', detail: 'x' })])
    const settled = newer.submissions.get('cm_1')
    expect(settled).toMatchObject({ dispatchState: 'rejected', rejection: { kind: 'futureKind' } })
    expect(settled && classifyDispatchRejection(settled)).toEqual({
      category: 'undelivered',
      verdict: null
    })
    // Not a fact at all: dropped, leaving the reason.
    const malformed = fold([submission, rejected('queueFull')]).submissions.get('cm_1')
    expect(malformed).not.toHaveProperty('rejection')
    expect(malformed && classifyDispatchRejection(malformed)).toMatchObject({ kind: 'queueFull' })
  })

  // Set only by a failed start's writer; a host from before it, or any other writer, writes none.
  describe('the start that rejected it', () => {
    const rejectedBy = (rejectedByStartKey: unknown, state = 'rejected'): JournalRow => {
      const row: JournalRow = {
        kind: 'dispatch',
        clientMessageId: 'cm_1',
        state: state === 'rejected' ? 'rejected' : 'unknown',
        providerItemId: null,
        reason: "Codex couldn't start.",
        rejection: { kind: 'startFailed' },
        ...base(2)
      }
      // A row read from disk carries whatever the host that wrote it did.
      return Object.assign(row, { rejectedByStartKey })
    }

    it('copies it onto a rejected submission, beside the fact it leaves alone', () => {
      const settled = fold([submission, rejectedBy('generation-2')]).submissions.get('cm_1')
      expect(settled).toMatchObject({
        dispatchState: 'rejected',
        rejection: { kind: 'startFailed' },
        rejectedByStartKey: 'generation-2'
      })
      const unnamed = fold([submission, rejectedBy(undefined)]).submissions.get('cm_1')
      expect(unnamed).not.toHaveProperty('rejectedByStartKey')
      // Identity, not the situation: the verdict is the same whichever start it names.
      expect(settled && classifyDispatchRejection(settled)).toEqual(
        unnamed && classifyDispatchRejection(unnamed)
      )
      const doubt = fold([submission, rejectedBy('generation-2', 'unknown')]).submissions.get(
        'cm_1'
      )
      expect(doubt).not.toHaveProperty('rejectedByStartKey')
    })

    it('drops a malformed one when read, never the row', () => {
      for (const malformed of ['', 7, { generation: 'generation-2' }]) {
        const parsed = parseJournalRow(serializeJournalRow(rejectedBy(malformed)))
        expect(parsed.ok).toBe(true)
        const settled = parsed.ok ? fold([submission, parsed.row]).submissions.get('cm_1') : null
        expect(settled).toMatchObject({
          dispatchState: 'rejected',
          rejection: { kind: 'startFailed' }
        })
        expect(settled).not.toHaveProperty('rejectedByStartKey')
      }
    })
  })
})
