import { describe, expect, it } from 'vitest'
import { isAdmissibleAgentJournalItemBody } from './agent-session-journal-schemas'
import type { AgentJournalItemBody } from './agent-session-journal-types'
import {
  agentJournalStopAnswerReplaces,
  agentJournalStopAnswerTook,
  readAgentJournalStopAnswer
} from './agent-session-stop-answer'

/** A Stop's note as a host of some version wrote it. */
function note(stop: unknown): AgentJournalItemBody {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: stands in for a row read from disk, whose `stop` this build may not know; the reader under test validates it.
  return { kind: 'status', text: 'Cancellation requested.', stop } as AgentJournalItemBody
}

describe('readAgentJournalStopAnswer', () => {
  it('reads the answer and the event it answers', () => {
    expect(readAgentJournalStopAnswer(note({ answer: 'declined', eventAt: 5 }))).toEqual({
      answer: 'declined',
      eventAt: 5
    })
    expect(readAgentJournalStopAnswer(note({ answer: 'took' }))).toEqual({ answer: 'took' })
  })

  it("reads an older host's note, a newer host's unknown answer, and any other row as no answer", () => {
    expect(
      readAgentJournalStopAnswer({ kind: 'status', text: 'Cancellation requested.' })
    ).toBeUndefined()
    expect(readAgentJournalStopAnswer(note({ answer: 'withdrawn', eventAt: 5 }))).toBeUndefined()
    expect(
      readAgentJournalStopAnswer({ kind: 'message', role: 'user', blocks: [] })
    ).toBeUndefined()
  })

  it("keeps a newer host's unknown answer admissible, so the row is never dropped as malformed", () => {
    expect(isAdmissibleAgentJournalItemBody(note({ answer: 'withdrawn', eventAt: 5 }))).toBe(true)
    expect(isAdmissibleAgentJournalItemBody(note({ answer: '' }))).toBe(false)
  })
})

describe('agentJournalStopAnswerTook', () => {
  it('counts a taken interrupt and an owed end, and nothing else', () => {
    expect(
      (['took', 'end-owed', 'declined', 'interrupt-unconfirmed', 'no-effect'] as const).filter(
        agentJournalStopAnswerTook
      )
    ).toEqual(['took', 'end-owed'])
  })
})

describe('agentJournalStopAnswerReplaces', () => {
  it('never hides an answer that the same Stop took behind one that it did not', () => {
    for (const next of ['declined', 'interrupt-unconfirmed', 'no-effect'] as const) {
      expect(
        agentJournalStopAnswerReplaces({ answer: 'took', eventAt: 5 }, { answer: next, eventAt: 5 })
      ).toBe(false)
    }
    expect(
      agentJournalStopAnswerReplaces(
        { answer: 'end-owed', eventAt: 5 },
        { answer: 'no-effect', eventAt: 5 }
      )
    ).toBe(false)
  })

  it('lets an owed end that failed revise its answer', () => {
    expect(
      agentJournalStopAnswerReplaces(
        { answer: 'end-owed', eventAt: 5 },
        { answer: 'interrupt-unconfirmed', eventAt: 5 }
      )
    ).toBe(true)
  })

  it('lets a later Stop, a taken answer, or a first answer write', () => {
    expect(
      agentJournalStopAnswerReplaces(
        { answer: 'took', eventAt: 5 },
        { answer: 'no-effect', eventAt: 9 }
      )
    ).toBe(true)
    expect(
      agentJournalStopAnswerReplaces(
        { answer: 'declined', eventAt: 5 },
        { answer: 'took', eventAt: 5 }
      )
    ).toBe(true)
    expect(agentJournalStopAnswerReplaces(undefined, { answer: 'no-effect' })).toBe(true)
  })
})
