// A message the host accepted and then rejected stays in the desktop's chat where it was sent,
// marked not sent, from the host's own history: a crash can lose the outbox, never the host's row.

import { describe, expect, it } from 'vitest'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../../../shared/agent-session-journal-item-key'
import {
  DISPATCH_REJECTED_CANCELLED,
  DISPATCH_REJECTED_HOST_RESTARTED
} from '../../../../shared/structured-agent-session-dispatch-rejection'
import { projectStructuredAgentSessionMessages as projectShared } from '../../../../shared/structured-agent-session-message-projection'
import { structuredAgentSessionSendBodyFingerprint } from '../../../../shared/structured-agent-session-mutation'
import {
  createStructuredAgentSessionOutboxEntry,
  type StructuredAgentSessionOutboxEntry
} from '../../../../shared/structured-agent-session-outbox'
import { structuredAgentSessionDeliveryNotices } from './structured-agent-session-delivery-notices'
import { projectStructuredAgentSessionMessages } from './structured-agent-session-message-projection'

const SESSION = 'session-1'

function body(text: string) {
  return {
    kind: 'message' as const,
    role: 'user' as const,
    blocks: [{ type: 'text' as const, text }]
  }
}

function fingerprint(text: string): string {
  return structuredAgentSessionSendBodyFingerprint(SESSION, body(text))
}

function userItem(id: string, sequence: number, text: string): AgentJournalRenderItem {
  return {
    itemId: agentJournalSubmissionKey(id),
    revision: 1,
    sequence,
    observedAt: sequence,
    body: body(text)
  }
}

function answer(sequence: number): AgentJournalRenderItem {
  return {
    itemId: `answer-${sequence}`,
    revision: 1,
    sequence,
    observedAt: sequence,
    body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'ok' }] }
  }
}

function submission(
  id: string,
  text: string,
  submittedAt: number,
  patch: Partial<AgentJournalSubmission> = {}
): AgentJournalSubmission {
  return {
    clientMessageId: id,
    fence: 1,
    payloadFingerprint: fingerprint(text),
    dispatchState: 'accepted',
    providerItemId: `provider-${id}`,
    reason: null,
    submittedAt,
    resolvedAt: submittedAt,
    ...patch
  }
}

/** Rejected on the next open after a crash, before the agent ever got it. */
function restartRejected(id: string, text: string, submittedAt: number): AgentJournalSubmission {
  return submission(id, text, submittedAt, {
    dispatchState: 'rejected',
    providerItemId: null,
    reason: DISPATCH_REJECTED_HOST_RESTARTED,
    rejection: { kind: 'hostRestarted' }
  })
}

function withdrawn(id: string, text: string, submittedAt: number): AgentJournalSubmission {
  return submission(id, text, submittedAt, {
    dispatchState: 'rejected',
    providerItemId: null,
    reason: DISPATCH_REJECTED_CANCELLED,
    rejection: { kind: 'cancelled' }
  })
}

function outboxEntry(
  id: string,
  text: string,
  patch: Partial<StructuredAgentSessionOutboxEntry> = {}
): StructuredAgentSessionOutboxEntry {
  return {
    ...createStructuredAgentSessionOutboxEntry({
      clientMessageId: id,
      sessionId: SESSION,
      text,
      attachments: [],
      queuedAt: 50
    }),
    ...patch
  }
}

function rows(messages: ReturnType<typeof projectStructuredAgentSessionMessages>) {
  return messages
    .filter((message) => message.role === 'user')
    .map((message) => ({
      id: message.id,
      text: message.blocks[0]?.type === 'text' ? message.blocks[0].text : null,
      unsent: message.unsent ?? false
    }))
}

const SEED = submission('seed', 'seed', 1)
const SEED_ROWS = [userItem('seed', 1, 'seed'), answer(2)]

describe('a message the host accepted and then rejected, on the desktop', () => {
  it('stays where it was sent, as not sent, with no outbox entry left after a crash', () => {
    const items = [...SEED_ROWS, userItem('lost', 3, 'fix the parser')]
    const messages = projectStructuredAgentSessionMessages(
      items,
      [],
      [SEED, restartRejected('lost', 'fix the parser', 3)]
    )

    expect(rows(messages)).toEqual([
      { id: agentJournalSubmissionKey('seed'), text: 'seed', unsent: false },
      { id: agentJournalSubmissionKey('lost'), text: 'fix the parser', unsent: true }
    ])
    // Its place is the host's: the row keeps the journal position it was recorded at.
    expect(
      messages.find((message) => message.id === agentJournalSubmissionKey('lost'))
    ).toMatchObject({ journalPosition: { sequence: 3, index: 0 }, source: 'transcript' })
  })

  it('says why from the host fact, with no Retry', () => {
    const notices = structuredAgentSessionDeliveryNotices(
      [],
      'Claude',
      () => {},
      [SEED, restartRejected('lost', 'fix the parser', 3)],
      [],
      new Set()
    )

    const notice = notices.get(agentJournalSubmissionKey('lost'))
    expect(notice?.text).toBe('Orca restarted before this message was sent.')
    expect(notice?.onRetry).toBeUndefined()
    expect([...notices.keys()]).toEqual([agentJournalSubmissionKey('lost')])
  })

  it("says only that it was not sent when the failed start's row already says why", () => {
    const failedStart = submission('first', 'hello', 3, {
      dispatchState: 'rejected',
      providerItemId: null,
      reason: 'Claude is not signed in.',
      rejection: { kind: 'notSignedIn' }
    })
    const notices = structuredAgentSessionDeliveryNotices(
      [],
      'Claude',
      () => {},
      [failedStart],
      [{ kind: 'notSignedIn' }],
      new Set()
    )

    expect(notices.get(agentJournalSubmissionKey('first'))).toEqual({
      text: 'Your message was not sent.'
    })
  })

  it('is hidden when a later message in the chat has the same body', () => {
    // An earlier build's Retry resent it under a new id, and that copy was delivered.
    const items = [...SEED_ROWS, userItem('old', 3, 'retry me'), userItem('resent', 4, 'retry me')]
    const submissions = [
      SEED,
      restartRejected('old', 'retry me', 3),
      submission('resent', 'retry me', 4)
    ]

    expect(rows(projectStructuredAgentSessionMessages(items, [], submissions))).toEqual([
      { id: agentJournalSubmissionKey('seed'), text: 'seed', unsent: false },
      { id: agentJournalSubmissionKey('resent'), text: 'retry me', unsent: false }
    ])
  })

  it('stays when the same body was only sent before it, or by a copy a Stop withdrew', () => {
    const items = [
      ...SEED_ROWS,
      userItem('first', 3, 'again'),
      userItem('failed', 4, 'again'),
      userItem('stopped', 5, 'again')
    ]
    const submissions = [
      SEED,
      submission('first', 'again', 3),
      restartRejected('failed', 'again', 4),
      withdrawn('stopped', 'again', 5)
    ]

    expect(rows(projectStructuredAgentSessionMessages(items, [], submissions))).toEqual([
      { id: agentJournalSubmissionKey('seed'), text: 'seed', unsent: false },
      { id: agentJournalSubmissionKey('first'), text: 'again', unsent: false },
      { id: agentJournalSubmissionKey('failed'), text: 'again', unsent: true }
    ])
  })

  it('keeps a message a Stop withdrew hidden: it went back to its sender', () => {
    const items = [...SEED_ROWS, userItem('stopped', 3, 'never mind')]
    const submissions = [SEED, withdrawn('stopped', 'never mind', 3)]

    expect(rows(projectStructuredAgentSessionMessages(items, [], submissions))).toEqual([
      { id: agentJournalSubmissionKey('seed'), text: 'seed', unsent: false }
    ])
    expect(
      structuredAgentSessionDeliveryNotices([], 'Claude', () => {}, submissions, [], new Set()).size
    ).toBe(0)
  })
})

describe('one row per rejected message while the outbox still holds it', () => {
  const items = [...SEED_ROWS, userItem('held', 3, 'host copy')]
  // Fingerprinted from the host's own copy, so only the shared id ties the two rows together.
  const rejected = restartRejected('held', 'host copy', 3)
  const held = outboxEntry('held', 'outbox copy', {
    state: 'rejected',
    lastFailure: { kind: 'rejected', reason: DISPATCH_REJECTED_HOST_RESTARTED }
  })
  const heldRow = { id: agentJournalSubmissionKey('held'), text: 'outbox copy', unsent: true }
  const hostRow = { id: agentJournalSubmissionKey('held'), text: 'host copy', unsent: true }
  const seedRow = { id: agentJournalSubmissionKey('seed'), text: 'seed', unsent: false }

  it('outbox first: the host rejecting it leaves the outbox row, with its Retry, in the host place', () => {
    const dispatching = { ...held, state: 'dispatching' as const, lastFailure: undefined }
    expect(rows(projectStructuredAgentSessionMessages(SEED_ROWS, [dispatching], [SEED]))).toEqual([
      seedRow,
      { ...heldRow, unsent: false }
    ])

    const messages = projectStructuredAgentSessionMessages(items, [held], [SEED, rejected])
    expect(rows(messages)).toEqual([seedRow, heldRow])
    expect(messages.at(-1)?.journalPosition).toEqual({ sequence: 3, index: 0 })
    const notices = structuredAgentSessionDeliveryNotices(
      [held],
      'Claude',
      () => {},
      [SEED, rejected],
      [],
      new Set()
    )
    expect(notices.get(heldRow.id)?.onRetry).toBeDefined()

    // The outbox lets it go: the host's row takes over, still one row.
    expect(rows(projectStructuredAgentSessionMessages(items, [], [SEED, rejected]))).toEqual([
      seedRow,
      hostRow
    ])
  })

  it('host first: the outbox picking it up afterwards replaces the host row', () => {
    expect(rows(projectStructuredAgentSessionMessages(items, [], [SEED, rejected]))).toEqual([
      seedRow,
      hostRow
    ])
    expect(rows(projectStructuredAgentSessionMessages(items, [held], [SEED, rejected]))).toEqual([
      seedRow,
      heldRow
    ])
  })

  it("hides it behind the outbox's resend under a new id until the host records that", () => {
    const hostItems = [...SEED_ROWS, userItem('held', 3, 'outbox copy')]
    const resent = restartRejected('held', 'outbox copy', 3)
    const resend = outboxEntry('resend', 'outbox copy')
    expect(
      rows(projectStructuredAgentSessionMessages(hostItems, [resend], [SEED, resent]))
    ).toEqual([
      seedRow,
      { id: agentJournalSubmissionKey('resend'), text: 'outbox copy', unsent: false }
    ])

    // Its Retry was refused before the host recorded it: still the one outbox row.
    const refused = {
      ...resend,
      lastAttemptAt: 60,
      lastFailure: { kind: 'refused' as const, code: 'agent_session_journal_unreadable' as const }
    }
    expect(
      rows(projectStructuredAgentSessionMessages(hostItems, [refused], [SEED, resent]))
    ).toEqual([
      seedRow,
      { id: agentJournalSubmissionKey('resend'), text: 'outbox copy', unsent: true }
    ])
  })
})

describe('the phone', () => {
  it('still hides every accepted-then-rejected message: it gives the text back to its composer', () => {
    const items = [
      ...SEED_ROWS,
      userItem('lost', 3, 'fix the parser'),
      userItem('stopped', 4, 'never mind')
    ]
    const submissions = [
      SEED,
      restartRejected('lost', 'fix the parser', 3),
      withdrawn('stopped', 'never mind', 4)
    ]

    expect(rows(projectShared(items, [], submissions, { rejectedInPlace: false }))).toEqual([
      { id: agentJournalSubmissionKey('seed'), text: 'seed', unsent: false }
    ])
  })
})
