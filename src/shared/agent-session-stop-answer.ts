// A Stop's note: the key it is written under, the answer it records (`AgentJournalStopNoteAnswer`),
// whether that answer says the Stop took effect, and which answer may replace another on the note.

import { parseAgentJournalItemKey } from './agent-session-journal-item-key'
import {
  AGENT_JOURNAL_STOP_ANSWERS,
  type AgentJournalItemBody,
  type AgentJournalItemIdentity,
  type AgentJournalStopAnswer,
  type AgentJournalStopNoteAnswer
} from './agent-session-journal-types'

const STOP_NOTE_PREFIX = 'stop:'

/** A Stop's note, keyed by the turn it stopped (or, with no turn, by its operation). */
export function structuredAgentSessionStopNoteIdentity(stopKey: string): AgentJournalItemIdentity {
  return { provider: 'orca', clientMessageId: `${STOP_NOTE_PREFIX}${stopKey}` }
}

/** Whether a journal row is a Stop's note. */
export function isStructuredAgentSessionStopNote(itemId: string): boolean {
  const identity = parseAgentJournalItemKey(itemId)
  return identity?.provider === 'orca' && identity.clientMessageId.startsWith(STOP_NOTE_PREFIX)
}

function isAgentJournalStopAnswer(value: unknown): value is AgentJournalStopAnswer {
  return AGENT_JOURNAL_STOP_ANSWERS.some((answer) => answer === value)
}

/** The Stop answer a row records; undefined for any other row, an older host's note, or an answer
 *  this build does not know, which reads as no answer. */
export function readAgentJournalStopAnswer(
  body: AgentJournalItemBody | undefined
): AgentJournalStopNoteAnswer | undefined {
  const stop = body?.kind === 'status' ? body.stop : undefined
  if (!stop || !isAgentJournalStopAnswer(stop.answer)) {
    return undefined
  }
  const { eventId } = stop
  return typeof eventId === 'string' && eventId.length > 0
    ? { answer: stop.answer, eventId }
    : { answer: stop.answer }
}

/** Whether an answer says the Stop took effect: its interrupt was taken, or its end of the child is
 *  done or still owed. */
export function agentJournalStopAnswerTook(answer: AgentJournalStopAnswer): boolean {
  switch (answer) {
    case 'took':
    case 'end-owed':
      return true
    case 'declined':
    case 'interrupt-unconfirmed':
    case 'no-effect':
      return false
  }
}

/** Whether `next` may replace `previous` on one note. A later answer that the Stop did not take
 *  never hides one that says the same Stop did; only the failure of an owed end revises that. */
export function agentJournalStopAnswerReplaces(
  previous: AgentJournalStopNoteAnswer | undefined,
  next: AgentJournalStopNoteAnswer
): boolean {
  if (
    previous === undefined ||
    previous.eventId !== next.eventId ||
    !agentJournalStopAnswerTook(previous.answer) ||
    agentJournalStopAnswerTook(next.answer)
  ) {
    return true
  }
  return previous.answer === 'end-owed' && next.answer === 'interrupt-unconfirmed'
}
