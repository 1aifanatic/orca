import { describe, expect, it } from 'vitest'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session-journal-types'
import type { AgentSessionFailureFact } from '../../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../../shared/agent-session-failure-words'
import {
  agentJournalItemKey,
  agentJournalSubmissionKey
} from '../../../../shared/agent-session-journal-item-key'
import { agentJournalTurnBody } from '../../../../shared/agent-session-turn-record'
import {
  structuredAgentSessionCommandResultRowIdentity,
  structuredAgentSessionCommandResultRows
} from '../../../../shared/structured-agent-session-command-entry'
import { structuredAgentSessionStartFailureFacts } from '../../../../shared/structured-agent-session-recorded-rejection-words'
import { structuredAgentSessionStartFailureRowIdentity } from '../../../../shared/structured-agent-session-start-failure-row-key'
import { structuredAgentSessionDeliveryNotices } from './structured-agent-session-delivery-notices'
import { projectStructuredAgentSessionMessages as projectForPhone } from '../../../../shared/structured-agent-session-message-projection'
import { createStructuredAgentSessionOutboxEntry } from '../../../../shared/structured-agent-session-outbox'
import { projectStructuredAgentSessionMessages } from './structured-agent-session-message-projection'

const NO_CARDS: readonly string[] = []
const PHONE = { rejectedInPlace: true }

function submission(index: number): AgentJournalSubmission {
  return {
    clientMessageId: `client-${index}`,
    fence: 1,
    payloadFingerprint: `fingerprint-${index}`,
    dispatchState: 'accepted',
    providerItemId: `provider-${index}`,
    reason: null,
    submittedAt: index,
    resolvedAt: index
  }
}

function item(index: number): AgentJournalRenderItem {
  return {
    itemId: `journal-${index}`,
    revision: 1,
    sequence: index,
    observedAt: index,
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: `send ${index}` }] }
  }
}

describe('structured agent session message projection', () => {
  it('shows a recorded send the host did not deliver as not sent, never as sent', () => {
    const rejected = { ...submission(0), dispatchState: 'rejected' as const, providerItemId: null }
    const refusedItem = { ...item(0), itemId: agentJournalSubmissionKey(rejected.clientMessageId) }
    const acceptedItem = item(1)
    // In no turn, at its journal place, so a reader that draws the list as it comes (the phone)
    // puts it where the host recorded it.
    expect(
      projectStructuredAgentSessionMessages([refusedItem, acceptedItem], [], [rejected], NO_CARDS)
    ).toMatchObject([
      { id: refusedItem.itemId, role: 'user', unsent: true, journalPosition: expect.anything() },
      { id: acceptedItem.itemId, role: 'user' }
    ])
  })

  it('keeps a recorded send in the chat after its outbox entry is gone and the host settles it undelivered', () => {
    // Orca restarted mid-send: the entry left this client, then the next agent start proved the
    // provider never took the message.
    const notDelivered = {
      ...submission(0),
      dispatchState: 'rejected' as const,
      providerItemId: null,
      reason: 'not_delivered'
    }
    const recordedItem = {
      ...item(0),
      itemId: agentJournalSubmissionKey(notDelivered.clientMessageId)
    }
    const messages = projectStructuredAgentSessionMessages(
      [recordedItem],
      [],
      [notDelivered],
      NO_CARDS
    )
    expect(messages).toMatchObject([
      {
        id: recordedItem.itemId,
        unsent: true,
        blocks: [{ type: 'text', text: 'send 0' }],
        journalPosition: { sequence: 0 }
      }
    ])
  })

  it('leaves out a send the user withdrew with Stop', () => {
    const withdrawn = {
      ...submission(0),
      dispatchState: 'rejected' as const,
      providerItemId: null,
      reason: 'provider_cancelled_before_start'
    }
    const withdrawnItem = {
      ...item(0),
      itemId: agentJournalSubmissionKey(withdrawn.clientMessageId)
    }
    expect(
      projectStructuredAgentSessionMessages([withdrawnItem], [], [withdrawn], NO_CARDS)
    ).toEqual([])
  })

  it("shows the sender's recorded rejection once, from the journal, even before its entry leaves", () => {
    const rejected = { ...submission(0), dispatchState: 'rejected' as const, providerItemId: null }
    const refusedItem = { ...item(0), itemId: agentJournalSubmissionKey(rejected.clientMessageId) }
    const draft = {
      ...createStructuredAgentSessionOutboxEntry({
        clientMessageId: rejected.clientMessageId,
        sessionId: 'session-1',
        text: 'send 0',
        attachments: [],
        queuedAt: 1
      }),
      state: 'dispatching' as const
    }
    expect(
      projectStructuredAgentSessionMessages([refusedItem], [draft], [rejected], NO_CARDS)
    ).toEqual([expect.objectContaining({ id: refusedItem.itemId, unsent: true })])
  })

  it('keeps the not-sent original when the same text is sent again as a new message', () => {
    const rejected = { ...submission(0), dispatchState: 'rejected' as const, providerItemId: null }
    const refusedItem = { ...item(0), itemId: agentJournalSubmissionKey(rejected.clientMessageId) }
    const resend = createStructuredAgentSessionOutboxEntry({
      clientMessageId: 'rotated-id',
      sessionId: 'session-1',
      text: 'send 0',
      attachments: [],
      queuedAt: 2
    })
    expect(
      projectStructuredAgentSessionMessages([refusedItem], [resend], [rejected], NO_CARDS)
    ).toEqual([
      expect.objectContaining({ id: refusedItem.itemId, unsent: true }),
      expect.objectContaining({ id: agentJournalSubmissionKey('rotated-id') })
    ])
  })

  // A rejected command is the host's like any send: its row stays, and its line says why only
  // where no loaded host row already does. The sender's reply stays quiet (command-send tests).
  const busy = { text: 'thread busy', audience: 'person' as const }
  const startFailed: AgentSessionFailureFact = { kind: 'providerStartFailed' }
  it.each<{
    name: string
    rejection: AgentSessionFailureFact
    row?: 'result' | 'start'
    line: string
  }>([
    {
      name: 'blocked at handover',
      rejection: { kind: 'commandRefused' },
      line: "This command didn't run. Try it again."
    },
    {
      name: 'refused by the provider',
      rejection: { kind: 'providerRejected', detail: busy },
      row: 'result',
      line: 'Your message was not sent.'
    },
    {
      name: 'rejected by a failed start',
      rejection: startFailed,
      row: 'start',
      line: 'Your message was not sent.'
    }
  ])('keeps a /compact $name, said once', ({ rejection, row, line }) => {
    const compact = {
      ...submission(0),
      dispatchState: 'rejected' as const,
      providerItemId: null,
      rejection
    }
    const userItemId = agentJournalSubmissionKey(compact.clientMessageId)
    const turnItemId = agentJournalItemKey({ provider: 'orca', clientMessageId: 'command-turn:c' })
    const hostRow = (
      itemId: string,
      fact: AgentSessionFailureFact,
      turnScope?: AgentJournalRenderItem['turnScope']
    ): AgentJournalRenderItem => ({
      itemId,
      revision: 1,
      sequence: 2,
      observedAt: 2,
      ...(turnScope ? { turnScope } : {}),
      body: {
        kind: 'status',
        tone: 'error',
        ...agentSessionFailureWords(fact, { agentName: 'Codex', surface: 'row' })
      }
    })
    const items: AgentJournalRenderItem[] = [
      {
        itemId: userItemId,
        revision: 1,
        sequence: 0,
        observedAt: 0,
        body: {
          kind: 'message',
          role: 'user',
          blocks: [{ type: 'text', text: '/compact' }],
          command: { name: 'compact' }
        }
      },
      ...(row === 'result'
        ? [
            {
              itemId: turnItemId,
              revision: 1,
              sequence: 1,
              observedAt: 1,
              body: agentJournalTurnBody({
                turnId: 'compact:c',
                state: 'completed',
                outcome: 'failure',
                userItemId,
                requestedAt: 0,
                startedAt: 1,
                completedAt: 2
              })
            },
            hostRow(
              agentJournalItemKey(
                structuredAgentSessionCommandResultRowIdentity(compact.clientMessageId)
              ),
              { kind: 'compactionFailed', detail: busy },
              { kind: 'turn', turnItemId }
            )
          ]
        : []),
      ...(row === 'start'
        ? [
            hostRow(
              agentJournalItemKey(structuredAgentSessionStartFailureRowIdentity('g')),
              startFailed
            )
          ]
        : [])
    ]
    for (const messages of [
      projectStructuredAgentSessionMessages(items, [], [compact], NO_CARDS),
      projectForPhone(items, [], [compact], PHONE)
    ]) {
      expect(messages.filter((message) => message.unsent === true).map((m) => m.id)).toEqual([
        userItemId
      ])
      expect(messages).toHaveLength(row ? 2 : 1)
    }
    const notices = structuredAgentSessionDeliveryNotices(
      [],
      'Codex',
      [compact],
      structuredAgentSessionStartFailureFacts(items),
      structuredAgentSessionCommandResultRows(items)
    )
    expect(notices.get(userItemId)?.text).toBe(line)
  })

  // The host sends a queued draft under a fresh id per hand-off; its card keeps the text meanwhile.
  it('leaves a rejected queued-draft hand-off to its card: one bubble once a later hand-off lands', () => {
    const handOff = (index: number, dispatchState: 'rejected' | 'accepted') => ({
      ...submission(index),
      clientMessageId: `handoff-${index}`,
      queuedMessageId: 'draft-1',
      dispatchState,
      ...(dispatchState === 'rejected'
        ? {
            providerItemId: null,
            reason: 'host_restarted',
            rejection: { kind: 'hostRestarted' as const }
          }
        : {})
    })
    const handOffRow = (index: number): AgentJournalRenderItem => ({
      ...item(index),
      itemId: agentJournalSubmissionKey(`handoff-${index}`),
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'same draft text' }] }
    })
    const items = [handOffRow(1), handOffRow(2)]
    const submissions = [handOff(1, 'rejected'), handOff(2, 'accepted')]
    for (const messages of [
      projectStructuredAgentSessionMessages(items, [], submissions, NO_CARDS),
      projectForPhone(items, [], submissions, PHONE)
    ]) {
      expect(messages).toEqual([
        expect.objectContaining({ id: agentJournalSubmissionKey('handoff-2') })
      ])
      expect(messages[0]?.unsent).toBeUndefined()
    }
  })

  it.each([5, 10])('renders %i rapid accepted desktop sends exactly once', (sendCount) => {
    const outbox = Array.from({ length: sendCount }, (_, index) =>
      createStructuredAgentSessionOutboxEntry({
        clientMessageId: `client-${index}`,
        sessionId: 'session-1',
        text: `send ${index}`,
        attachments: [],
        queuedAt: index
      })
    )
    const messages = projectStructuredAgentSessionMessages(
      Array.from({ length: sendCount }, (_, index) => item(index)),
      outbox,
      Array.from({ length: sendCount }, (_, index) => submission(sendCount - index - 1)),
      NO_CARDS
    )

    expect(messages.filter((message) => message.role === 'user')).toHaveLength(sendCount)
    expect(messages.map((message) => message.id)).toEqual(
      Array.from({ length: sendCount }, (_, index) => `journal-${index}`)
    )
  })

  it('renders one bubble while the submission is still dispatching', () => {
    const outbox = [
      createStructuredAgentSessionOutboxEntry({
        clientMessageId: 'client-pending',
        sessionId: 'session-1',
        text: 'Ok thanks',
        attachments: [],
        queuedAt: 1
      })
    ]
    // The host's WAL row is on screen while the provider round trip is in flight.
    const walItem: AgentJournalRenderItem = {
      itemId: agentJournalSubmissionKey('client-pending'),
      revision: 0,
      sequence: 1,
      observedAt: 1,
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Ok thanks' }] }
    }
    const pending: AgentJournalSubmission = {
      ...submission(0),
      clientMessageId: 'client-pending',
      dispatchState: 'pending',
      providerItemId: null,
      resolvedAt: null
    }

    const messages = projectStructuredAgentSessionMessages([walItem], outbox, [pending], NO_CARDS)
    const optimistic = projectStructuredAgentSessionMessages([], outbox, [], NO_CARDS)

    expect(messages.filter((message) => message.role === 'user')).toHaveLength(1)
    expect(messages.map((message) => message.id)).toEqual([walItem.itemId])
    expect(optimistic[0]?.id).toBe(messages[0]?.id)
  })

  it('keeps an optimistic send until its acceptance arrives', () => {
    const outbox = [
      createStructuredAgentSessionOutboxEntry({
        clientMessageId: 'client-pending',
        sessionId: 'session-1',
        text: 'pending',
        attachments: [],
        queuedAt: 1
      })
    ]

    expect(projectStructuredAgentSessionMessages([], outbox, [], NO_CARDS)).toMatchObject([
      { id: agentJournalSubmissionKey('client-pending'), role: 'user' }
    ])
  })
})
