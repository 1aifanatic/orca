// The one notice a host stop owes a turn it cut short when nobody's Stop ended it: a quit, an idle
// eviction or a teardown. That turn reads like a finished one, so this row is what says it stopped.

import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import {
  agentSessionFailureWords,
  type AgentSessionFailureWordsContext
} from '../../../shared/agent-session-failure-words'
import { isRootAgentJournalItem } from '../../../shared/agent-session-journal-producer'
import type { AgentJournalRenderItem } from '../../../shared/agent-session-journal-types'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import type { JournalLifecycleMutationInput } from '../agent-session-journal/journal-row-builders'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'

export type StructuredAgentSessionStopCut = {
  journal: Pick<AgentSessionJournal, 'stopMarks' | 'itemFence'>
  /** The stopped child's fence: an end with no verdict on its latest turn is this stop's cut. */
  fence: number
  /** When the host's fallback ends a turn no adapter settled. */
  fallbackEndedAt: number
  failureTextContext?: AgentSessionFailureWordsContext
}

/** The latest root turn, when it ends as news: still running for the fallback to end, or ended by
 *  the stopped child's adapter with no verdict. Null when a person's Stop decides it. */
function cutTurn(
  items: readonly AgentJournalRenderItem[],
  stop: StructuredAgentSessionStopCut
): AgentJournalRenderItem | null {
  const latest = items.findLast(
    (item) => isRootAgentJournalItem(item) && readAgentJournalTurn(item.body) !== null
  )
  const turn = latest ? readAgentJournalTurn(latest.body) : null
  if (!latest || !turn) {
    return null
  }
  if (turn.state === 'running') {
    return stop.journal.stopMarks.personStopDecides(turn.turnId, stop.fallbackEndedAt)
      ? null
      : latest
  }
  return turn.state === 'interrupted' &&
    turn.outcome === undefined &&
    stop.journal.itemFence(latest.itemId) === stop.fence
    ? latest
    : null
}

/** The notice for the turn this stop cut, unless one already explains it (an exit row, or this
 *  notice from an earlier attempt): one explanation per cut. */
export function structuredAgentSessionStopCutNotice(
  sessionId: string,
  items: readonly AgentJournalRenderItem[],
  stop: StructuredAgentSessionStopCut
): JournalLifecycleMutationInput | null {
  const turn = cutTurn(items, stop)
  if (!turn) {
    return null
  }
  const explained = items.some(
    (item) =>
      item.body.kind === 'status' &&
      item.body.tone === 'error' &&
      item.turnScope?.kind === 'turn' &&
      item.turnScope.turnItemId === turn.itemId
  )
  if (explained) {
    return null
  }
  return {
    kind: 'item',
    // Named by the turn it explains, so a retried settle rewrites this row instead of adding one.
    identity: { provider: 'orca', clientMessageId: `stop-cut:${sessionId}:${turn.itemId}` },
    body: {
      kind: 'status',
      ...agentSessionFailureWords(agentSessionFailureFact('providerExited'), {
        ...stop.failureTextContext,
        surface: 'row'
      }),
      tone: 'error'
    },
    turnScope: { kind: 'turn', turnItemId: turn.itemId }
  }
}
