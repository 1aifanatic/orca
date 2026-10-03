// A send a Stop took back before the agent started it stays where it was sent, with one row after
// it saying so, on every client: the journal already holds the send and why it was refused.

import { describe, expect, it } from 'vitest'
import { agentJournalSubmissionKey } from './agent-session-journal-item-key'
import type {
  AgentJournalItemBody,
  AgentJournalRenderItem,
  AgentJournalSubmission,
  AgentJournalTurnScope
} from './agent-session-journal-types'
import {
  NATIVE_CHAT_STOPPED_BEFORE_START_PRESENTATION,
  NATIVE_CHAT_STOPPED_BEFORE_START_TEXT
} from './native-chat-stopped-before-start'
import {
  DISPATCH_REJECTED_CANCELLED,
  DISPATCH_REJECTED_WRITE_FAILED
} from './structured-agent-session-dispatch-rejection'
import { projectStructuredAgentSessionMessages } from './structured-agent-session-message-projection'
import {
  projectNativeChatTranscript,
  projectNativeChatTranscriptMessages
} from './native-chat-transcript-projection'
import { nativeChatRowsInDrawOrder } from './native-chat-turn-grouping'
import { nativeChatTurnMembership } from './native-chat-turn-membership'

let sequence = 0

function entry(
  itemId: string,
  body: AgentJournalItemBody,
  turnScope: AgentJournalTurnScope = { kind: 'thread' }
): AgentJournalRenderItem {
  sequence += 1
  return { itemId, revision: 0, sequence, observedAt: sequence, body, turnScope }
}

const said = (itemId: string, text: string, turnItemId: string) =>
  entry(
    itemId,
    { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text }] },
    { kind: 'turn', turnItemId }
  )

const sent = (id: string, text: string) =>
  entry(agentJournalSubmissionKey(id), {
    kind: 'message',
    role: 'user',
    blocks: [{ type: 'text', text }]
  })

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

const stopped = (id: string, overrides: Partial<AgentJournalSubmission> = {}) =>
  submission(id, { dispatchState: 'rejected', reason: DISPATCH_REJECTED_CANCELLED, ...overrides })

/** Each row as id and role, in the order the transcript draws them. */
function rows(items: AgentJournalRenderItem[], submissions: AgentJournalSubmission[]) {
  return projectNativeChatTranscriptMessages(
    projectStructuredAgentSessionMessages(items, [], submissions)
  ).map((message) => ({ id: message.id, role: message.role }))
}

const user = (id: string) => ({ id: agentJournalSubmissionKey(id), role: 'user' })
const stopRow = (id: string) => ({
  id: `stopped-before-start:${agentJournalSubmissionKey(id)}`,
  role: 'system'
})

describe('a send a Stop took back before the agent started it', () => {
  it('stays where it was sent, with one row after it', () => {
    const items = [sent('warm-up', 'warm up'), sent('never-ran', 'look around')]

    expect(rows(items, [submission('warm-up'), stopped('never-ran')])).toEqual([
      user('warm-up'),
      user('never-ran'),
      stopRow('never-ran')
    ])
    const [, , row] = projectStructuredAgentSessionMessages(items, [], [stopped('never-ran')])
    expect(row?.blocks).toEqual([
      {
        type: 'text',
        text: NATIVE_CHAT_STOPPED_BEFORE_START_TEXT,
        presentation: NATIVE_CHAT_STOPPED_BEFORE_START_PRESENTATION
      }
    ])
    expect(row?.journalPosition).toEqual(
      projectStructuredAgentSessionMessages(items, [], [stopped('never-ran')])[1]?.journalPosition
    )
  })

  it('reads the same from the typed fact as from the older marker', () => {
    const items = [sent('never-ran', 'look around')]
    const typed = stopped('never-ran', {
      reason: 'This message was withdrawn before the agent started it.',
      rejection: { kind: 'cancelled' }
    })

    expect(rows(items, [typed])).toEqual(rows(items, [stopped('never-ran')]))
  })

  it('shares one row with the sends taken back right before it', () => {
    const items = [sent('first', 'one'), sent('second', 'two')]

    expect(rows(items, [stopped('first'), stopped('second')])).toEqual([
      user('first'),
      user('second'),
      stopRow('second')
    ])
  })

  it('stays in the turn that opened for it, whose end already says it was stopped', () => {
    const items = [
      sent('opened', 'look around'),
      entry('turn-1', {
        kind: 'turn',
        turnId: 'turn-1',
        state: 'interrupted',
        outcome: 'cancellation',
        userItemId: agentJournalSubmissionKey('opened')
      })
    ]

    expect(rows(items, [stopped('opened')])).toEqual([user('opened')])
  })

  // Codex reports the turn open before it echoes the send, so the record names the provider's key.
  it('stays in the turn that opened for it before the provider echoed it', () => {
    const items = [
      sent('opened', 'look around'),
      entry('turn-1', {
        kind: 'turn',
        turnId: 'turn-1',
        state: 'interrupted',
        outcome: 'cancellation',
        userItemId: 'codex:thread-1:turn-1:0',
        startedAt: 5
      })
    ]

    expect(rows(items, [stopped('opened', { resolvedAt: 10 })])).toEqual([user('opened')])
  })

  // A steer joins the running turn, whose interrupted end already says the Stop took it.
  it('stays in the turn it was steered into, with no row of its own', () => {
    const items = [
      sent('first', 'look around'),
      entry('t1', {
        kind: 'turn',
        turnId: 't1',
        state: 'interrupted',
        outcome: 'cancellation',
        userItemId: agentJournalSubmissionKey('first')
      }),
      entry(
        agentJournalSubmissionKey('steer'),
        { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'and check the tests' }] },
        { kind: 'turn', turnItemId: 't1' }
      )
    ]

    expect(rows(items, [submission('first'), stopped('steer')])).toEqual([
      user('first'),
      user('steer')
    ])
  })

  it('keeps its row when a turn starts only after the Stop took it back', () => {
    const items = [
      sent('never-ran', 'look around'),
      entry('wake', {
        kind: 'turn',
        turnId: 'wake',
        state: 'completed',
        userItemId: 'claude:wake',
        startedAt: 20
      }),
      said('wake-note', 'Checking the build.', 'wake')
    ]

    expect(rows(items, [stopped('never-ran', { resolvedAt: 10 })])).toEqual([
      user('never-ran'),
      stopRow('never-ran'),
      { id: 'wake-note', role: 'assistant' }
    ])
  })

  it('is drawn after the turn it waited behind when it was never handed over', () => {
    const items = [
      sent('first', 'first prompt'),
      entry('t1', {
        kind: 'turn',
        turnId: 't1',
        state: 'interrupted',
        outcome: 'cancellation',
        userItemId: agentJournalSubmissionKey('first')
      }),
      said('before', 'working on it', 't1'),
      sent('queued', 'queued while t1 ran'),
      said('after', 'more t1 output', 't1'),
      entry(
        'note',
        { kind: 'status', text: 'Cancellation requested.' },
        { kind: 'turn', turnItemId: 't1' }
      )
    ]

    expect(
      rows(items, [submission('first'), stopped('queued', { handoverRecorded: true })])
    ).toEqual([
      user('first'),
      { id: 'before', role: 'assistant' },
      { id: 'after', role: 'assistant' },
      { id: 'note', role: 'system' },
      user('queued'),
      stopRow('queued')
    ])
  })

  // A follow-up made before Codex opened the turn, then stopped: the turn opened for the first
  // send, and the follow-up waited on it, so that turn's own rows come before the follow-up's.
  it("is drawn after a turn that opened while it waited, with that turn's rows above it", () => {
    const items = [
      sent('first', 'look around'),
      sent('follow-up', 'and check the tests'),
      entry('turn-1', {
        kind: 'turn',
        turnId: 'turn-1',
        state: 'interrupted',
        outcome: 'cancellation',
        userItemId: 'codex:thread-1:turn-1:0',
        startedAt: 5
      }),
      entry(
        'stop:turn-1',
        { kind: 'status', text: 'Cancellation requested.' },
        { kind: 'turn', turnItemId: 'turn-1' }
      )
    ]
    const submissions = [
      stopped('first', { resolvedAt: 10 }),
      stopped('follow-up', { resolvedAt: 10 })
    ]
    const journal = { items, submissions }
    const { conversation } = projectNativeChatTranscript(
      projectStructuredAgentSessionMessages(items, [], submissions),
      undefined,
      journal
    )
    const { drawOrder } = nativeChatTurnMembership(conversation, journal)

    expect(nativeChatRowsInDrawOrder(conversation, drawOrder).map((row) => row.id)).toEqual([
      agentJournalSubmissionKey('first'),
      'stop:turn-1',
      agentJournalSubmissionKey('follow-up'),
      `stopped-before-start:${agentJournalSubmissionKey('follow-up')}`
    ])
  })

  it('leaves a queued card to hold its own text', () => {
    const items = [sent('card-send', 'from a card')]

    expect(rows(items, [stopped('card-send', { queuedMessageId: 'card-1' })])).toEqual([])
  })

  it('keeps any other refused send out of the conversation', () => {
    const items = [sent('refused', 'hello')]

    expect(
      rows(items, [
        submission('refused', { dispatchState: 'rejected', reason: DISPATCH_REJECTED_WRITE_FAILED })
      ])
    ).toEqual([])
  })
})
