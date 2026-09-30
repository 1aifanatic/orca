// Every /compact press carries its own id, so a retry after a lost reply is a new operation. Read
// from the journal, it repeats the caller's last /compact while that one waits, runs, or compacted
// with nothing sent since; a /compact that did not compact, or anything newer, lets it run again.

import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import {
  STRUCTURED_AGENT_SESSION_COMPACT_COMMAND,
  structuredAgentSessionCommandTurn
} from './structured-agent-session-command-turn'

/** The /compact a press repeats, or null when it should run. */
export function repeatedStructuredCompaction(
  journal: Pick<AgentSessionJournal, 'submissions' | 'itemBody' | 'newestTurn'>,
  sentByCaller: (clientMessageId: string) => boolean
): AgentJournalSubmission | null {
  const last = journal.submissions().at(-1)
  const body = last && journal.itemBody(agentJournalSubmissionKey(last.clientMessageId))
  if (
    !last ||
    body?.kind !== 'message' ||
    body.command?.name !== STRUCTURED_AGENT_SESSION_COMPACT_COMMAND ||
    !sentByCaller(last.clientMessageId)
  ) {
    return null
  }
  const commandTurn = structuredAgentSessionCommandTurn(last.clientMessageId)
  const turn = readAgentJournalTurn(journal.itemBody(commandTurn.itemId) ?? undefined)
  if (!turn) {
    // Not handed over yet: it still waits, so the press joins it.
    return last.dispatchState === 'pending' ? last : null
  }
  if (journal.newestTurn()?.turnId !== commandTurn.turnId) {
    return null
  }
  return turn.state === 'running' || (turn.state === 'completed' && turn.outcome === 'success')
    ? last
    : null
}
