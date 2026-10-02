// A message the host accepted to hand over later and then rejected before any handover sits where
// it was rejected: what the agent did while it waited happened before it.

import { describe, expect, it } from 'vitest'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import { DISPATCH_REJECTED_HOST_RESTARTED } from '../../../shared/structured-agent-session-dispatch-rejection'
import { projectJournalBatch } from '../agent-session-wire/agent-session-journal-batch'
import { applyJournalRow, createJournalReducerState, renderJournalState } from './journal-reducer'
import { buildJournalSubmissionRow, journalRowBase } from './journal-row-builders'
import type { JournalRow } from './journal-row-schema'

function journal() {
  const state = createJournalReducerState('session-1', 'epoch-1')
  let seq = 0
  const push = (next: JournalRow): JournalRow => {
    applyJournalRow(state, next)
    return next
  }
  return {
    state,
    submission(clientMessageId: string, handoverRecorded = true) {
      seq += 1
      return push(
        buildJournalSubmissionRow({
          state,
          clientMessageId,
          payloadFingerprint: `fp-${clientMessageId}`,
          providerHandle: { kind: 'codex', threadId: 'thread-1' },
          body: {
            kind: 'message',
            role: 'user',
            blocks: [{ type: 'text', text: clientMessageId }]
          },
          seq,
          fence: 1,
          ts: 1_000 + seq,
          ...(handoverRecorded ? { handoverRecorded: true } : {})
        })
      )
    },
    dispatch(clientMessageId: string, state_: 'pending' | 'rejected') {
      seq += 1
      return push({
        kind: 'dispatch',
        clientMessageId,
        state: state_,
        providerItemId: null,
        reason: state_ === 'rejected' ? DISPATCH_REJECTED_HOST_RESTARTED : null,
        ...(state_ === 'rejected' ? { rejection: { kind: 'hostRestarted' } } : {}),
        ...journalRowBase(state.epoch, seq, 1, 1_000 + seq),
        turnScope: AGENT_JOURNAL_THREAD_SCOPE
      })
    },
    /** Other work between the send and its settlement, as a turn running ahead of it would write. */
    advance(rows: number) {
      seq += rows
      state.lastSequence = seq
    }
  }
}

function placed(state: ReturnType<typeof journal>['state'], clientMessageId: string) {
  const item = state.items.get(agentJournalSubmissionKey(clientMessageId))
  return item && { sequence: item.sequence, observedAt: item.observedAt, scope: item.turnScope }
}

describe('a queued message rejected before its handover', () => {
  it('sits at the rejection, in no turn', () => {
    const { state, submission, dispatch, advance } = journal()
    submission('waiting')
    advance(300)
    dispatch('waiting', 'rejected')

    expect(placed(state, 'waiting')).toEqual({
      sequence: 302,
      observedAt: 1_302,
      scope: AGENT_JOURNAL_THREAD_SCOPE
    })
  })

  it('reaches a subscriber at the tail, so the newest page holds it', () => {
    const { state, submission, dispatch, advance } = journal()
    submission('waiting')
    advance(300)
    const rejection = dispatch('waiting', 'rejected')

    const projected = projectJournalBatch({
      rows: [rejection],
      snapshot: renderJournalState(state),
      afterSequence: 301
    })
    expect(projected.ok && projected.batch.items.map((item) => item.sequence)).toEqual([302])
    expect(renderJournalState(state).items.at(-1)?.itemId).toBe(
      agentJournalSubmissionKey('waiting')
    )
  })

  it('keeps one handed over before its rejection where the handover put it', () => {
    const { state, submission, dispatch, advance } = journal()
    submission('steer')
    advance(10)
    dispatch('steer', 'pending')
    advance(10)
    dispatch('steer', 'rejected')

    expect(placed(state, 'steer')?.sequence).toBe(12)
  })

  it('keeps a send dispatched as it was recorded where it was sent', () => {
    const { state, submission, dispatch, advance } = journal()
    submission('direct', false)
    advance(10)
    dispatch('direct', 'rejected')

    expect(placed(state, 'direct')?.sequence).toBe(1)
  })
})
