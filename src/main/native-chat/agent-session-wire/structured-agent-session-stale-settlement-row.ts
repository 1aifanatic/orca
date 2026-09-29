// The one row a settle of a gone generation writes, and which: the provider's exit when a proof
// names the owner that was mid-response, else at a crash boundary that the session did not
// survive. One boundary never shows two.

import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import {
  agentSessionFailureWords,
  type AgentSessionFailureWordsContext
} from '../../../shared/agent-session-failure-words'
import { parseAgentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import type { AgentJournalRenderItem } from '../../../shared/agent-session-journal-types'
import type { AgentSessionDeathEvidence } from '../../../shared/agent-session-record'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import type { JournalLifecycleMutationInput } from '../agent-session-journal/journal-row-builders'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'

const CRASH_BOUNDARY_ROW_PREFIX = 'crash-boundary:'

/** The death evidence is Orca's log text, never a sentence for a person: a row says only that
 *  the provider stopped, or that the session did not survive the restart. No Retry: sending a
 *  new message is how the chat continues. Each is named by what it explains, so a retry after a
 *  partly written settle adds no second row. */
export function staleSettlementRow(
  input: {
    sessionId: string
    fence: number
    deathEvidence: AgentSessionDeathEvidence | null
    failureTextContext?: AgentSessionFailureWordsContext
    crashBoundary?: { sendsLeftInDoubt: number }
  },
  work: { inProgress: boolean; diedInProgress: boolean; provenUnexplained: boolean }
): Omit<Extract<JournalLifecycleMutationInput, { kind: 'item' }>, 'kind'> | null {
  const context = { ...input.failureTextContext, surface: 'row' as const }
  const evidence = input.deathEvidence
  if (evidence && (work.diedInProgress || work.provenUnexplained)) {
    return {
      identity: {
        provider: 'orca',
        clientMessageId: `stale-session:${input.sessionId}:death-${evidence.ownerFence ?? 'unowned'}-${evidence.observedAt}`
      },
      body: {
        kind: 'status',
        ...agentSessionFailureWords(agentSessionFailureFact('providerExited'), context)
      }
    }
  }
  const boundary = input.crashBoundary
  if (boundary && (work.inProgress || boundary.sendsLeftInDoubt > 0)) {
    return {
      identity: {
        provider: 'orca',
        clientMessageId: `${CRASH_BOUNDARY_ROW_PREFIX}${input.sessionId}:${input.fence}`
      },
      body: {
        kind: 'status',
        tone: 'notice',
        ...agentSessionFailureWords(agentSessionFailureFact('hostRestarted'), context)
      }
    }
  }
  return null
}

function isCrashBoundaryRow(item: AgentJournalRenderItem): boolean {
  const identity = parseAgentJournalItemKey(item.itemId)
  return (
    identity?.provider === 'orca' && identity.clientMessageId.startsWith(CRASH_BOUNDARY_ROW_PREFIX)
  )
}

/** A turn only a crash boundary's open could settle is `unverifiable`, and that open already wrote
 *  the boundary's row after it; a proof arriving later revises the turn and owes no second row. */
export function crashBoundaryExplainedProvenTurn(
  evidence: AgentSessionDeathEvidence | null,
  journal: Pick<AgentSessionJournal, 'itemFence'>,
  items: readonly AgentJournalRenderItem[]
): boolean {
  const ownerFence = evidence?.ownerFence
  // The same turns `provenUnverifiableTurnRevisions` revises.
  const revised = items.findLastIndex(
    (item) =>
      readAgentJournalTurn(item.body)?.state === 'unverifiable' &&
      journal.itemFence(item.itemId) === ownerFence
  )
  return revised !== -1 && items.slice(revised + 1).some(isCrashBoundaryRow)
}
