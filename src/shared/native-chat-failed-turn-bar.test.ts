import { describe, expect, it } from 'vitest'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission,
  AgentJournalTurnLifecycle
} from './agent-session-journal-types'
import {
  describeNativeChatTurnStatus,
  formatNativeChatTurnStatusLabel,
  selectNativeChatTurnStatuses
} from './native-chat-turn-status'
import { selectStructuredAgentTurnBars } from './structured-agent-session-turn-timing'

function user(sequence: number, clientMessageId: string): AgentJournalRenderItem {
  return {
    itemId: `orca:${clientMessageId}`,
    revision: 0,
    sequence,
    observedAt: sequence * 1_000,
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: clientMessageId }] }
  }
}

function turnItemId(turnId: string): string {
  return `legacy:codex:thread:turn-lifecycle%3A${turnId}`
}

function turn(sequence: number, record: AgentJournalTurnLifecycle): AgentJournalRenderItem {
  return {
    itemId: turnItemId(record.turnId),
    revision: 1,
    sequence,
    observedAt: sequence * 1_000,
    body: { kind: 'turn', ...record }
  }
}

function accepted(clientMessageId: string, providerItemId: string): AgentJournalSubmission {
  return {
    clientMessageId,
    fence: 1,
    payloadFingerprint: 'fp',
    dispatchState: 'accepted',
    providerItemId,
    reason: null,
    submittedAt: 1,
    resolvedAt: 2
  }
}

/** Every settled bar the transcript would render, as its English label. */
function settledBarLabels(
  items: readonly AgentJournalRenderItem[],
  submissions: readonly AgentJournalSubmission[] = []
): Record<string, string> {
  const { settledTurns } = selectStructuredAgentTurnBars(items, submissions, null)
  const { completedByTurn } = selectNativeChatTurnStatuses(
    {},
    {
      activeTurnKey: '__unanchored__',
      isWorking: false,
      thinking: false,
      settledByTurn: settledTurns
    }
  )
  return Object.fromEntries(
    Object.entries(completedByTurn).map(([key, status]) => [
      key,
      formatNativeChatTurnStatusLabel({ ...status, elapsedSeconds: 0 })
    ])
  )
}

const timed = { startedAt: 10_000, completedAt: 194_000 }

describe('describeNativeChatTurnStatus for a failed turn', () => {
  it('says the turn failed after its settled duration', () => {
    expect(
      describeNativeChatTurnStatus({ workedSeconds: 184, elapsedSeconds: 0, outcome: 'failure' })
    ).toEqual({ key: 'failedAfter', duration: '3m 4s' })
    expect(
      formatNativeChatTurnStatusLabel({ workedSeconds: 184, elapsedSeconds: 0, outcome: 'failure' })
    ).toBe('Failed after 3m 4s')
  })

  it('keeps "Worked for" for success, a stop, and an unknown verdict', () => {
    for (const outcome of ['success', 'cancellation', null, undefined] as const) {
      expect(
        formatNativeChatTurnStatusLabel({ workedSeconds: 5, elapsedSeconds: 0, outcome })
      ).toBe('Worked for 5s')
    }
  })

  it('keeps the live clock while the turn runs, whatever the verdict', () => {
    expect(
      formatNativeChatTurnStatusLabel({
        workedSeconds: null,
        elapsedSeconds: 7,
        outcome: 'failure'
      })
    ).toBe('Working for 7s')
  })
})

describe('a settled turn bar reads the journal verdict', () => {
  const opened = (outcome?: AgentJournalTurnLifecycle['outcome']): AgentJournalRenderItem[] => [
    user(1, 'u1'),
    turn(2, {
      turnId: 't1',
      state: 'completed',
      userItemId: 'orca:u1',
      ...timed,
      ...(outcome ? { outcome } : {})
    })
  ]

  it('shows "Failed after" for a turn the provider failed', () => {
    expect(settledBarLabels(opened('failure'))).toEqual({ 'orca:u1': 'Failed after 3m 4s' })
  })

  it('shows "Worked for" for a successful turn', () => {
    expect(settledBarLabels(opened('success'))).toEqual({ 'orca:u1': 'Worked for 3m 4s' })
  })

  it('shows "Worked for" when nothing recorded a verdict', () => {
    expect(settledBarLabels(opened())).toEqual({ 'orca:u1': 'Worked for 3m 4s' })
  })

  it('finds the verdict through a provider key that resolves to the opener', () => {
    const items = [
      user(1, 'u1'),
      turn(2, {
        turnId: 't1',
        state: 'completed',
        userItemId: 'codex:thread:t1:0',
        ...timed,
        outcome: 'failure'
      })
    ]
    expect(settledBarLabels(items, [accepted('u1', 'codex:thread:t1:0')])).toEqual({
      'orca:u1': 'Failed after 3m 4s'
    })
  })

  it('keys a self-anchored failed turn by its own record', () => {
    // Provider-opened (or opener paged out): the record's own item anchors the bar.
    const self = turnItemId('resumed')
    const items = [
      user(1, 'u1'),
      turn(2, {
        turnId: 'resumed',
        state: 'completed',
        userItemId: self,
        ...timed,
        outcome: 'failure'
      })
    ]
    expect(settledBarLabels(items)).toEqual({ [self]: 'Failed after 3m 4s' })
  })

  it('renders nothing for an untimed failed record, never "Failed after 0s"', () => {
    const items = [
      user(1, 'u1'),
      turn(2, { turnId: 't1', state: 'completed', userItemId: 'orca:u1', outcome: 'failure' })
    ]
    expect(settledBarLabels(items)).toEqual({})
  })
})
