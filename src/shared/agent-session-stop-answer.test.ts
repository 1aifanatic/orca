import { describe, expect, it } from 'vitest'
import { isAdmissibleAgentJournalItemBody } from './agent-session-journal-schemas'
import type { AgentJournalItemBody } from './agent-session-journal-types'
import {
  agentJournalStopAnswerReplaces,
  agentJournalStopAnswerTook,
  isStructuredAgentSessionStopNote,
  readAgentJournalStopAnswer,
  structuredAgentSessionStopNoteIdentity
} from './agent-session-stop-answer'
import { agentJournalItemKey } from './agent-session-journal-item-key'

/** A Stop's note as a host of some version wrote it. */
function note(stop: unknown): AgentJournalItemBody {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: stands in for a row read from disk, whose `stop` this build may not know; the reader under test validates it.
  return { kind: 'status', text: 'Cancellation requested.', stop } as AgentJournalItemBody
}

describe('readAgentJournalStopAnswer', () => {
  it('reads the answer and the event it answers', () => {
    expect(readAgentJournalStopAnswer(note({ answer: 'declined', eventId: 'stop-a' }))).toEqual({
      answer: 'declined',
      eventId: 'stop-a'
    })
    expect(readAgentJournalStopAnswer(note({ answer: 'took' }))).toEqual({ answer: 'took' })
  })

  it('keeps a row whose event id is malformed out of the journal, as any malformed fact', () => {
    expect(isAdmissibleAgentJournalItemBody(note({ answer: 'took', eventId: '' }))).toBe(false)
    expect(isAdmissibleAgentJournalItemBody(note({ answer: 'took', eventId: 5 }))).toBe(false)
  })

  it("reads an older host's note, a newer host's unknown answer, and any other row as no answer", () => {
    expect(
      readAgentJournalStopAnswer({ kind: 'status', text: 'Cancellation requested.' })
    ).toBeUndefined()
    expect(
      readAgentJournalStopAnswer(note({ answer: 'withdrawn', eventId: 'stop-a' }))
    ).toBeUndefined()
    expect(
      readAgentJournalStopAnswer({ kind: 'message', role: 'user', blocks: [] })
    ).toBeUndefined()
  })

  it("keeps a newer host's unknown answer admissible, so the row is never dropped as malformed", () => {
    expect(isAdmissibleAgentJournalItemBody(note({ answer: 'withdrawn', eventId: 'stop-a' }))).toBe(
      true
    )
    expect(isAdmissibleAgentJournalItemBody(note({ answer: '' }))).toBe(false)
  })
})

describe("a Stop's note key", () => {
  it('tells a Stop note from any other row', () => {
    expect(
      isStructuredAgentSessionStopNote(
        agentJournalItemKey(structuredAgentSessionStopNoteIdentity('turn-1'))
      )
    ).toBe(true)
    expect(
      isStructuredAgentSessionStopNote(
        agentJournalItemKey({ provider: 'orca', clientMessageId: 'stop-event' })
      )
    ).toBe(false)
    expect(
      isStructuredAgentSessionStopNote(
        agentJournalItemKey({ provider: 'codex', threadId: 't', turnId: 'stop:1', ordinal: 0 })
      )
    ).toBe(false)
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
        agentJournalStopAnswerReplaces(
          { answer: 'took', eventId: 'stop-a' },
          { answer: next, eventId: 'stop-a' }
        )
      ).toBe(false)
    }
    expect(
      agentJournalStopAnswerReplaces(
        { answer: 'end-owed', eventId: 'stop-a' },
        { answer: 'no-effect', eventId: 'stop-a' }
      )
    ).toBe(false)
  })

  it('lets an owed end that failed revise its answer', () => {
    expect(
      agentJournalStopAnswerReplaces(
        { answer: 'end-owed', eventId: 'stop-a' },
        { answer: 'interrupt-unconfirmed', eventId: 'stop-a' }
      )
    ).toBe(true)
  })

  it('lets a later Stop, a taken answer, or a first answer write', () => {
    expect(
      agentJournalStopAnswerReplaces(
        { answer: 'took', eventId: 'stop-a' },
        { answer: 'no-effect', eventId: 'stop-b' }
      )
    ).toBe(true)
    expect(
      agentJournalStopAnswerReplaces(
        { answer: 'declined', eventId: 'stop-a' },
        { answer: 'took', eventId: 'stop-a' }
      )
    ).toBe(true)
    expect(agentJournalStopAnswerReplaces(undefined, { answer: 'no-effect' })).toBe(true)
  })
})
