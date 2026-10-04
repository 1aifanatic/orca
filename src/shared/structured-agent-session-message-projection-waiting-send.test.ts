// A send handed over while the turn before it still runs waits for that turn, so it is drawn after
// that turn's rows, never inside them. The journals here are the ones the shipped host wrote for
// sends queued behind /compact, all handed to Codex before the first one's turn opened.

import { describe, expect, it } from 'vitest'
import { agentJournalSubmissionKey } from './agent-session-journal-item-key'
import type {
  AgentJournalItemBody,
  AgentJournalRenderItem,
  AgentJournalSubmission,
  AgentJournalTurnScope
} from './agent-session-journal-types'
import { projectStructuredAgentSessionMessages } from './structured-agent-session-message-projection'
import { projectNativeChatTranscriptMessages } from './native-chat-transcript-projection'
import { nativeChatRowsInDrawOrder } from './native-chat-turn-grouping'
import { nativeChatTurnMembership } from './native-chat-turn-membership'

const THREAD = 'thread-1'
const THREAD_SCOPE: AgentJournalTurnScope = { kind: 'thread' }

function entry(
  itemId: string,
  sequence: number,
  body: AgentJournalItemBody,
  turnScope: AgentJournalTurnScope = THREAD_SCOPE
): AgentJournalRenderItem {
  return { itemId, revision: 0, sequence, observedAt: sequence, body, turnScope }
}

const sent = (id: string, sequence: number, text: string, turnScope?: AgentJournalTurnScope) =>
  entry(
    agentJournalSubmissionKey(id),
    sequence,
    { kind: 'message', role: 'user', blocks: [{ type: 'text', text }] },
    turnScope
  )

const said = (itemId: string, sequence: number, text: string, turnItemId: string) =>
  entry(
    itemId,
    sequence,
    { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text }] },
    { kind: 'turn', turnItemId }
  )

const turn = (turnId: string, sequence: number, state: 'running' | 'completed', opener: string) =>
  entry(`lifecycle:${turnId}`, sequence, {
    kind: 'turn',
    turnId,
    state,
    userItemId: opener,
    startedAt: sequence
  })

const providerKey = (turnId: string) => `codex:${THREAD}:${turnId}:0`

function submission(
  clientMessageId: string,
  overrides: Partial<AgentJournalSubmission> = {}
): AgentJournalSubmission {
  return {
    clientMessageId,
    fence: 1,
    payloadFingerprint: clientMessageId,
    dispatchState: 'accepted',
    providerItemId: null,
    reason: null,
    submittedAt: 1,
    resolvedAt: 2,
    ...overrides
  }
}

/** A finished warm-up and a finished /compact, with the given sends queued behind the compaction. */
function behindCompact(): AgentJournalRenderItem[] {
  return [
    sent('warm-up', 3, 'warm up'),
    turn('turn-1', 4, 'completed', providerKey('turn-1')),
    sent('compact', 9, '/compact'),
    turn('compact', 10, 'completed', agentJournalSubmissionKey('compact')),
    entry(
      'compacted',
      15,
      { kind: 'status', text: 'Context compacted' },
      { kind: 'turn', turnItemId: 'lifecycle:compact' }
    )
  ]
}

const finishedBefore = [
  submission('warm-up', { providerItemId: providerKey('turn-1') }),
  submission('compact')
]

/** Each row's text, in the order the transcript draws them. */
function drawn(items: AgentJournalRenderItem[], submissions: AgentJournalSubmission[]): string[] {
  const rows = projectNativeChatTranscriptMessages(
    projectStructuredAgentSessionMessages(items, [], submissions)
  )
  const { drawOrder } = nativeChatTurnMembership(rows, { items, submissions })
  return nativeChatRowsInDrawOrder(rows, drawOrder).map((row) =>
    row.blocks.map((block) => ('text' in block ? block.text : block.type)).join('')
  )
}

describe('a send handed over while the turn before it still runs', () => {
  it('is drawn after that turn, which streams above it', () => {
    const items = [
      ...behindCompact(),
      sent('first', 17, 'queued first'),
      sent('second', 18, 'queued second'),
      turn('turn-2', 19, 'running', providerKey('turn-2')),
      said('working', 22, 'working on the first', 'lifecycle:turn-2')
    ]

    expect(
      drawn(items, [
        ...finishedBefore,
        submission('first', { providerItemId: providerKey('turn-2'), handedOverAt: 5 }),
        submission('second', { dispatchState: 'pending', resolvedAt: null, handedOverAt: 6 })
      ])
    ).toEqual([
      'warm up',
      '/compact',
      'Context compacted',
      'queued first',
      'working on the first',
      'queued second'
    ])
  })

  it('stays after that turn when a Stop leaves it in doubt', () => {
    const items = [
      ...behindCompact(),
      sent('zero', 17, 'queued zero'),
      sent('b', 18, 'queued B'),
      turn('turn-2', 19, 'completed', providerKey('turn-2')),
      said('answer', 22, 'answer to zero', 'lifecycle:turn-2'),
      entry('stop-note', 26, { kind: 'status', text: 'Cancellation requested.' })
    ]

    expect(
      drawn(items, [
        ...finishedBefore,
        submission('zero', { providerItemId: providerKey('turn-2'), handedOverAt: 5 }),
        submission('b', {
          dispatchState: 'unknown',
          reason: 'provider_closed_before_acknowledgement',
          handedOverAt: 5
        })
      ])
    ).toEqual([
      'warm up',
      '/compact',
      'Context compacted',
      'queued zero',
      'answer to zero',
      'queued B',
      'Cancellation requested.'
    ])
  })

  // A later send steered into that turn belongs to it and stays where it joined; the waiting one
  // still waits for the turn's end.
  it('is drawn after a later send steered into that turn', () => {
    const items = [
      ...behindCompact(),
      sent('zero', 18, 'queued zero'),
      sent('a', 19, 'queued A'),
      turn('turn-2', 20, 'running', providerKey('turn-2')),
      said('working', 23, 'working on zero', 'lifecycle:turn-2'),
      sent('b', 24, 'queued B', { kind: 'turn', turnItemId: 'lifecycle:turn-2' }),
      said('more', 25, 'more on zero', 'lifecycle:turn-2')
    ]

    expect(
      drawn(items, [
        ...finishedBefore,
        submission('zero', { providerItemId: providerKey('turn-2'), handedOverAt: 5 }),
        submission('a', { dispatchState: 'pending', resolvedAt: null, handedOverAt: 6 }),
        submission('b', { dispatchState: 'pending', resolvedAt: null, handedOverAt: 7 })
      ])
    ).toEqual([
      'warm up',
      '/compact',
      'Context compacted',
      'queued zero',
      'working on zero',
      'queued B',
      'more on zero',
      'queued A'
    ])
  })

  // Its own turn opened after the one before it ended, so nothing it waited on reaches past it.
  it('stays at its own row once the turn before it has ended', () => {
    const items = [
      ...behindCompact(),
      sent('first', 17, 'queued first'),
      turn('turn-2', 18, 'completed', providerKey('turn-2')),
      said('answer', 19, 'answer to the first', 'lifecycle:turn-2'),
      sent('second', 20, 'queued second'),
      turn('turn-3', 21, 'running', providerKey('turn-3')),
      said('working', 22, 'working on the second', 'lifecycle:turn-3')
    ]

    expect(
      drawn(items, [
        ...finishedBefore,
        submission('first', { providerItemId: providerKey('turn-2'), handedOverAt: 5 }),
        submission('second', { providerItemId: providerKey('turn-3'), handedOverAt: 6 })
      ])
    ).toEqual([
      'warm up',
      '/compact',
      'Context compacted',
      'queued first',
      'answer to the first',
      'queued second',
      'working on the second'
    ])
  })
})
