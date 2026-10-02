// The turn-end rule as a Stop that named no turn binds it: every turn that ends while the Stop
// settles, then only the turn it stopped. A cancellation already written stays one.

import { describe, expect, it } from 'vitest'
import type { AgentJournalItemBody } from '../../../shared/agent-session-journal-types'
import { createJournalReducerState, type JournalReducerState } from './journal-reducer'
import type { JournalStopEvent } from './journal-row-schema'
import {
  beginJournalStopSettle,
  personStopDecidesTurn,
  turnEndAfterStop
} from './journal-stop-turn-end'
import { JournalStopMarks } from './journal-stop-marks'

const STOPPED_AT = 1_000

function stateWith(event?: JournalStopEvent): JournalReducerState {
  const state = createJournalReducerState('session-1', 'epoch-1')
  state.queuePauseMarks.latestStop = event ? { sequence: 5, event } : null
  return state
}

type TurnBody = Extract<AgentJournalItemBody, { kind: 'turn' }>

function ended(turnId: string): TurnBody {
  return { kind: 'turn', turnId, state: 'interrupted', completedAt: STOPPED_AT + 10 }
}

function withTurn(state: JournalReducerState, body: AgentJournalItemBody): void {
  state.items.set('turn-item', {
    itemId: 'turn-item',
    revision: 1,
    body,
    sequence: 3,
    observedAt: STOPPED_AT
  })
}

const turnless: JournalStopEvent = { reason: 'user-stop', at: STOPPED_AT }

describe("a person's Stop that named no turn", () => {
  it('makes any turn that ends while it settles theirs', () => {
    const state = stateWith(turnless)
    const marks = new JournalStopMarks({ state: () => state })
    marks.beginSettle()

    expect(turnEndAfterStop(state, 'turn-item', ended('turn-a'))).toMatchObject({
      outcome: 'cancellation'
    })
    expect(personStopDecidesTurn(state, null)).toBe(true)
  })

  it('once settled, binds only the turn it stopped', () => {
    const state = stateWith(turnless)
    const marks = new JournalStopMarks({ state: () => state })
    marks.settled(marks.beginSettle(), 'turn-a')

    expect(turnEndAfterStop(state, 'turn-item', ended('turn-a'))).toMatchObject({
      outcome: 'cancellation'
    })
    expect(turnEndAfterStop(state, 'other-item', ended('turn-b'))).not.toHaveProperty('outcome')
    expect(personStopDecidesTurn(state, null)).toBe(false)
    expect(personStopDecidesTurn(state, 'turn-a')).toBe(true)
  })

  it('binds nothing once it settled having stopped nothing', () => {
    const state = stateWith(turnless)
    const marks = new JournalStopMarks({ state: () => state })
    marks.settled(marks.beginSettle())

    expect(turnEndAfterStop(state, 'turn-item', ended('turn-a'))).not.toHaveProperty('outcome')
  })

  it('binds nothing before it settles: a relaunch folds the event alone', () => {
    const state = stateWith(turnless)

    expect(turnEndAfterStop(state, 'turn-item', ended('turn-a'))).not.toHaveProperty('outcome')
    expect(personStopDecidesTurn(state, null)).toBe(false)
  })

  it('keeps the turn an earlier press bound when pressed again', () => {
    const state = stateWith(turnless)
    const marks = new JournalStopMarks({ state: () => state })
    marks.settled(marks.beginSettle(), 'turn-a')
    marks.settled(marks.beginSettle())

    expect(turnEndAfterStop(state, 'turn-item', ended('turn-a'))).toMatchObject({
      outcome: 'cancellation'
    })
  })
})

describe('a Stop with nothing in memory to bind', () => {
  it.each([
    ['one that named its turn', { reason: 'user-stop', turnId: 'turn-a', at: STOPPED_AT }],
    ['a host stop', { reason: 'host-stop', at: STOPPED_AT }]
  ] satisfies [string, JournalStopEvent][])('opens no settle: %s', (_label, event) => {
    expect(beginJournalStopSettle(stateWith(event))).toBeNull()
  })
})

describe('an end already written as a cancellation', () => {
  it('stays one when a later end with no verdict is written over it', () => {
    const state = stateWith()
    withTurn(state, { ...ended('turn-a'), outcome: 'cancellation' })

    expect(turnEndAfterStop(state, 'turn-item', ended('turn-a'))).toMatchObject({
      outcome: 'cancellation'
    })
  })

  it("gives way to the provider's own verdict", () => {
    const state = stateWith()
    withTurn(state, { ...ended('turn-a'), outcome: 'cancellation' })
    const failed: TurnBody = { ...ended('turn-a'), outcome: 'failure' }

    expect(turnEndAfterStop(state, 'turn-item', failed)).toEqual(failed)
  })
})
