// A settlement's proven turn end says a Stop's unconfirmed note on that turn took; nothing else.

import { describe, expect, it } from 'vitest'
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity,
  AgentJournalRenderItem
} from '../../../shared/agent-session-journal-types'
import { agentJournalTurnBody } from '../../../shared/agent-session-turn-record'
import type { JournalLifecycleMutationInput } from '../agent-session-journal/journal-row-builders'
import { structuredAgentSessionStopNoteIdentity } from './structured-agent-session-command-turn'
import { stopNoteRevisionsForEndedTurns } from './structured-agent-session-stop-note-revisions'

const TURN: AgentJournalItemIdentity = {
  provider: 'legacy',
  agent: 'codex',
  sessionId: 'session-1',
  recordId: 'turn-lifecycle:turn-1'
}
const TURN_ITEM = agentJournalItemKey(TURN)
const UNCONFIRMED: AgentJournalItemBody = {
  kind: 'status',
  ...agentSessionFailureWords(agentSessionFailureFact('cancelUnconfirmed'), { surface: 'row' })
}

function note(key: string, body: AgentJournalItemBody, turnItemId = TURN_ITEM) {
  const identity = structuredAgentSessionStopNoteIdentity(key)
  return {
    identity,
    item: {
      itemId: agentJournalItemKey(identity),
      revision: 1,
      sequence: 3,
      observedAt: 3,
      body,
      turnScope: { kind: 'turn', turnItemId }
    } satisfies AgentJournalRenderItem
  }
}

function turnEnd(state: 'interrupted' | 'completed'): JournalLifecycleMutationInput {
  return {
    kind: 'item',
    identity: TURN,
    body: agentJournalTurnBody({ turnId: 'turn-1', state, completedAt: 10 }),
    turnScope: { kind: 'thread' }
  }
}

describe('a Stop note on a turn a settlement ends', () => {
  it('says the Stop took when the turn ends interrupted', () => {
    const { identity, item } = note('turn-1', UNCONFIRMED)

    expect(stopNoteRevisionsForEndedTurns([item], [turnEnd('interrupted')])).toEqual([
      {
        kind: 'item',
        identity,
        body: { kind: 'status', text: 'Cancellation requested.' },
        turnScope: { kind: 'turn', turnItemId: TURN_ITEM }
      }
    ])
  })

  it('is left alone when the turn completes on its own', () => {
    const { item } = note('turn-1', UNCONFIRMED)

    expect(stopNoteRevisionsForEndedTurns([item], [turnEnd('completed')])).toEqual([])
  })

  it('is left alone on another turn, or when it already says the Stop took', () => {
    const elsewhere = note('turn-2', UNCONFIRMED, 'another-turn').item
    const took = note('turn-1', { kind: 'status', text: 'Cancellation requested.' }).item

    expect(stopNoteRevisionsForEndedTurns([elsewhere, took], [turnEnd('interrupted')])).toEqual([])
  })
})
