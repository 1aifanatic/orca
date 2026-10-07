// A structured send is recorded under the id it went out under, and its row carries that id. The
// phone settles the send's bubble, its photo preview and any unconfirmed hold by that row alone,
// whatever its text, wherever the host places it, delivered or not sent.

import { describe, expect, it } from 'vitest'
import { agentJournalSubmissionKey } from '../../../src/shared/agent-session-journal-item-key'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../src/shared/agent-session-journal-types'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import { projectStructuredAgentSessionMessages } from '../../../src/shared/structured-agent-session-message-projection'
import {
  countUserTextOccurrences,
  findLandedImagePreviewEchoes,
  findLandedUnconfirmedSends,
  normalizeReconcileText
} from './mobile-native-chat-draft-reconcile'
import {
  appendMobileNativeChatPending,
  type MobileNativeChatPendingMessage
} from './mobile-native-chat-pending-echo'
import { retireLandedMobileNativeChatPending } from './mobile-native-chat-pending-retirement'

const TEXT = 'fix the test'

function user(
  id: string,
  sequence: number,
  blocks: Extract<AgentJournalRenderItem['body'], { kind: 'message' }>['blocks']
): AgentJournalRenderItem {
  return {
    itemId: agentJournalSubmissionKey(id),
    revision: 1,
    sequence,
    observedAt: sequence,
    turnScope: { kind: 'thread' },
    body: { kind: 'message', role: 'user', blocks }
  }
}

function said(id: string, sequence: number, text: string): AgentJournalRenderItem {
  return user(id, sequence, [{ type: 'text', text }])
}

function answer(id: string, sequence: number): AgentJournalRenderItem {
  return {
    itemId: id,
    revision: 1,
    sequence,
    observedAt: sequence,
    body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'ok' }] }
  }
}

function submission(
  id: string,
  text: string,
  at: number,
  patch: Partial<AgentJournalSubmission> = {}
): AgentJournalSubmission {
  return {
    clientMessageId: id,
    fence: 1,
    payloadFingerprint: `body:${text}`,
    dispatchState: 'accepted',
    providerItemId: `provider-${id}`,
    reason: null,
    submittedAt: at,
    resolvedAt: at,
    ...patch
  }
}

function rejected(id: string, text: string, at: number): AgentJournalSubmission {
  return submission(id, text, at, {
    dispatchState: 'rejected',
    providerItemId: null,
    reason: 'provider_write_failed: broken pipe',
    resolvedAt: at + 1
  })
}

/** What the phone draws: the journal, with a recorded, rejected send in place as not sent. */
function phone(
  items: AgentJournalRenderItem[],
  submissions: AgentJournalSubmission[]
): NativeChatMessage[] {
  return projectStructuredAgentSessionMessages(items, [], submissions, { rejectedInPlace: true })
}

/** One bubble for a structured send, captured against `before`. */
function bubble(
  before: readonly NativeChatMessage[],
  clientMessageId: string,
  text: string,
  images?: string[]
): MobileNativeChatPendingMessage[] {
  const normalizedText = normalizeReconcileText(text)
  return (
    appendMobileNativeChatPending(
      {},
      'pending',
      `pending-${clientMessageId}`,
      {
        draftKey: 'draft',
        draftEditGeneration: 0,
        pendingKey: 'pending',
        normalizedText,
        baselineOccurrences: countUserTextOccurrences(before, normalizedText),
        baselineTailMessageId: before.at(-1)?.id ?? null,
        baselineResolved: true
      },
      text,
      images,
      clientMessageId
    ).pending ?? []
  )
}

/** The bubbles still drawn once `after` is the transcript. */
function left(after: readonly NativeChatMessage[], pending: MobileNativeChatPendingMessage[]) {
  const bound = new Set(findLandedImagePreviewEchoes(after, pending).map((echo) => echo.pendingId))
  return retireLandedMobileNativeChatPending(after, pending, bound).map((item) => item.id)
}

function held(
  before: readonly NativeChatMessage[],
  after: readonly NativeChatMessage[],
  clientMessageId: string,
  text: string
): boolean {
  return (
    findLandedUnconfirmedSends(after, [
      {
        draftKey: 'draft',
        pendingKey: 'pending',
        text,
        normalizedText: normalizeReconcileText(text),
        baselineTailMessageId: before.at(-1)?.id ?? null,
        clientMessageId,
        deadline: null
      }
    ]).length === 0
  )
}

const ORIGINAL = rejected('m1', TEXT, 10)
const BEFORE = phone([answer('hi', 5), said('m1', 11, TEXT)], [ORIGINAL])

describe('a same-text resend after a not-sent message', () => {
  it('keeps its bubble until its own row arrives, never settled by the original', () => {
    const pending = bubble(BEFORE, 'm2', TEXT)
    expect(left(BEFORE, pending)).toEqual(['pending-m2'])
    expect(held(BEFORE, BEFORE, 'm2', TEXT)).toBe(true)
  })

  // The projection drops the original once the resend is recorded after its rejection.
  it('retires its bubble and settles its hold on its own row, with the original gone', () => {
    const after = phone(
      [answer('hi', 5), said('m1', 11, TEXT), said('m2', 20, TEXT), answer('done', 21)],
      [ORIGINAL, submission('m2', TEXT, 20)]
    )
    expect(after.some((message) => message.id === agentJournalSubmissionKey('m1'))).toBe(false)
    expect(left(after, bubble(BEFORE, 'm2', TEXT))).toEqual([])
    expect(held(BEFORE, after, 'm2', TEXT)).toBe(false)
  })
})

describe('a send whose own row arrives already not sent', () => {
  const after = phone(
    [answer('hi', 5), said('m1', 11, TEXT), said('m2', 21, 'later')],
    [ORIGINAL, rejected('m2', 'later', 20)]
  )

  it('settles an ack-lost send, so no "Delivery unconfirmed" banner follows', () => {
    expect(after.at(-1)).toMatchObject({ id: agentJournalSubmissionKey('m2'), unsent: true })
    expect(held(BEFORE, after, 'm2', 'later')).toBe(false)
  })

  it('retires its bubble, so no copy stays beside the not-sent row', () => {
    expect(left(after, bubble(BEFORE, 'm2', 'later'))).toEqual([])
  })
})

// The newest row at send time can be one the host rejects only later: it moves that row to the
// rejection, past the new send's own row (R1P-1).
describe('a send whose boundary row the host moves past it', () => {
  const before = phone([answer('hi', 5), said('m1', 10, 'first')], [])
  const after = phone(
    [
      answer('hi', 5),
      user('m2', 20, [{ type: 'image-ref', path: '/host/a.png' }]),
      said('m1', 21, 'first')
    ],
    [rejected('m1', 'first', 20), submission('m2', '', 20)]
  )

  it('binds its photo to its own row and retires its bubble', () => {
    const pending = bubble(before, 'm2', '', ['file:///a.jpg'])
    expect(findLandedImagePreviewEchoes(after, pending)).toEqual([
      {
        pendingId: 'pending-m2',
        messageId: agentJournalSubmissionKey('m2'),
        images: ['file:///a.jpg']
      }
    ])
    expect(left(after, pending)).toEqual([])
  })

  it('settles an ack-lost send there too', () => {
    expect(held(before, after, 'm2', '')).toBe(false)
  })
})

describe('a captioned photo send', () => {
  const photo = (id: string, sequence: number) =>
    user(id, sequence, [
      { type: 'text', text: 'look' },
      { type: 'image-ref', path: `/host/${id}.png` }
    ])

  it('binds to its own row, never an older one with the same caption, not sent or delivered', () => {
    const before = phone([photo('m1', 10), photo('m3', 12)], [rejected('m1', 'look', 10)])
    const pending = bubble(before, 'm2', 'look', ['file:///b.jpg'])
    expect(left(before, pending)).toEqual(['pending-m2'])
    const after = phone(
      [photo('m1', 10), photo('m3', 12), photo('m2', 21)],
      [rejected('m1', 'look', 10), rejected('m2', 'look', 20)]
    )
    expect(findLandedImagePreviewEchoes(after, pending)).toEqual([
      {
        pendingId: 'pending-m2',
        messageId: agentJournalSubmissionKey('m2'),
        images: ['file:///b.jpg']
      }
    ])
    expect(left(after, pending)).toEqual([])
  })
})

// Two quick sends of the same text: the first is recorded and rejected before the second's row
// arrives. Its row is the first send's own, never the second's (R1P-3).
describe('two quick sends of the same text', () => {
  it('retires each bubble on its own row only', () => {
    const before = phone([answer('a0', 5)], [])
    const pending = [...bubble(before, 'm1', TEXT), ...bubble(before, 'm2', TEXT)]
    const firstOnly = phone([answer('a0', 5), said('m1', 11, TEXT)], [rejected('m1', TEXT, 10)])
    const bound = new Set<string>()
    const afterFirst = retireLandedMobileNativeChatPending(firstOnly, pending, bound)
    expect(afterFirst.map((item) => item.id)).toEqual(['pending-m2'])
    // The resend went out once the first was known not sent, so the first's row leaves.
    const both = phone(
      [answer('a0', 5), said('m1', 11, TEXT), said('m2', 12, TEXT)],
      [rejected('m1', TEXT, 10), submission('m2', TEXT, 12)]
    )
    expect(retireLandedMobileNativeChatPending(both, afterFirst, bound)).toEqual([])
  })
})
