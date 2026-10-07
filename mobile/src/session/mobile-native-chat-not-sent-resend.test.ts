// The phone draws a message the host recorded and then rejected in place, as not sent. The user's
// way on is to send its text again, as a new message. The phone's own echo of that resend must land
// on the new copy alone, never on the original.

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
  normalizeReconcileText,
  sendBaselineTailMessageId,
  sendBaselineUnsentMessageIds
} from './mobile-native-chat-draft-reconcile'
import { rebaseMobileNativeChatPendingBaselines } from './mobile-native-chat-pending-baseline'
import { appendMobileNativeChatPending } from './mobile-native-chat-pending-echo'
import { retireLandedMobileNativeChatPending } from './mobile-native-chat-pending-retirement'

const TEXT = 'fix the test'

function user(id: string, sequence: number, text: string): AgentJournalRenderItem {
  return {
    itemId: agentJournalSubmissionKey(id),
    revision: 1,
    sequence,
    observedAt: sequence,
    turnScope: { kind: 'thread' },
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text }] }
  }
}

function answer(id: string, sequence: number, text: string): AgentJournalRenderItem {
  return {
    itemId: id,
    revision: 1,
    sequence,
    observedAt: sequence,
    body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text }] }
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

function phone(
  items: AgentJournalRenderItem[],
  submissions: AgentJournalSubmission[]
): NativeChatMessage[] {
  return projectStructuredAgentSessionMessages(items, [], submissions, { rejectedInPlace: true })
}

const REJECTED = submission('m1', TEXT, 10, {
  dispatchState: 'rejected',
  providerItemId: null,
  reason: 'provider_write_failed: broken pipe',
  resolvedAt: 11
})
const BEFORE_ITEMS = [answer('hi', 5, 'Hi'), user('m1', 11, TEXT)]
const AFTER_ITEMS = [...BEFORE_ITEMS, user('m2', 20, TEXT), answer('done', 21, 'Done.')]
const AFTER_SUBMISSIONS = [REJECTED, submission('m2', TEXT, 20)]

describe('resending a not-sent message from the phone', () => {
  // The original leaves once the resend is recorded: the projection collapses a copy sent after its
  // rejection was known. The echo must not wait for a second copy that is never drawn.
  it('ends as the delivered resend alone, with no echo left', () => {
    const before = phone(BEFORE_ITEMS, [REJECTED])
    const normalizedText = normalizeReconcileText(TEXT)
    const origin = {
      draftKey: 'draft',
      draftEditGeneration: 0,
      pendingKey: 'pending',
      normalizedText,
      baselineOccurrences: countUserTextOccurrences(before, normalizedText),
      baselineTailMessageId: sendBaselineTailMessageId(before),
      baselineResolved: true,
      baselineUnsentMessageIds: sendBaselineUnsentMessageIds(before)
    }
    const pending = appendMobileNativeChatPending({}, 'pending', 'pending-1', origin, TEXT).pending

    const after = phone(AFTER_ITEMS, AFTER_SUBMISSIONS)
    expect(
      after.filter((message) => message.role === 'user').map((message) => message.unsent ?? false)
    ).toEqual([false])
    expect(retireLandedMobileNativeChatPending(after, pending ?? [], new Set())).toEqual([])
  })

  it('sees an ack-lost resend that landed as landed, so no doubt is raised', () => {
    const before = phone(BEFORE_ITEMS, [REJECTED])
    const landed = findLandedUnconfirmedSends(phone(AFTER_ITEMS, AFTER_SUBMISSIONS), [
      {
        draftKey: 'draft',
        pendingKey: 'pending',
        text: TEXT,
        normalizedText: normalizeReconcileText(TEXT),
        baselineTailMessageId: sendBaselineTailMessageId(before),
        baselineUnsentMessageIds: sendBaselineUnsentMessageIds(before),
        deadline: null
      }
    ])
    expect(landed).toHaveLength(1)
  })

  it('lets the older not-sent copy settle nothing while the resend is on its way', () => {
    const before = phone(BEFORE_ITEMS, [REJECTED])
    const normalizedText = normalizeReconcileText(TEXT)
    const origin = {
      draftKey: 'draft',
      draftEditGeneration: 0,
      pendingKey: 'pending',
      normalizedText,
      baselineOccurrences: countUserTextOccurrences(before, normalizedText),
      baselineTailMessageId: sendBaselineTailMessageId(before),
      baselineResolved: true,
      baselineUnsentMessageIds: sendBaselineUnsentMessageIds(before)
    }
    const pending = appendMobileNativeChatPending({}, 'pending', 'pending-1', origin, TEXT).pending
    expect(retireLandedMobileNativeChatPending(before, pending ?? [], new Set())).toHaveLength(1)
    expect(findLandedUnconfirmedSends(before, [{ ...origin, text: TEXT, deadline: null }])).toEqual(
      []
    )
  })
})

// The phone's first sight of its own row can already be the rejected one: a catch-up after the
// stream dropped, or a send made before the first read settled. That row settles the send.
describe('a phone send whose own row first appears as not sent', () => {
  const OWN_REJECTED = submission('m2', 'later', 20, {
    dispatchState: 'rejected',
    providerItemId: null,
    reason: 'provider_write_failed: broken pipe',
    resolvedAt: 21
  })
  const BEFORE = phone(BEFORE_ITEMS, [REJECTED])
  const AFTER = phone([...BEFORE_ITEMS, user('m2', 21, 'later')], [REJECTED, OWN_REJECTED])

  it('settles an ack-lost send, so no "Delivery unconfirmed" banner follows', () => {
    expect(
      findLandedUnconfirmedSends(AFTER, [
        {
          draftKey: 'draft',
          pendingKey: 'pending',
          text: 'later',
          normalizedText: normalizeReconcileText('later'),
          baselineTailMessageId: sendBaselineTailMessageId(BEFORE),
          baselineUnsentMessageIds: sendBaselineUnsentMessageIds(BEFORE),
          deadline: null
        }
      ])
    ).toHaveLength(1)
  })

  it("retires an accepted send's echo, so no bubble stays beside its row", () => {
    const normalizedText = normalizeReconcileText('later')
    const pending = appendMobileNativeChatPending(
      {},
      'pending',
      'pending-1',
      {
        draftKey: 'draft',
        draftEditGeneration: 0,
        pendingKey: 'pending',
        normalizedText,
        baselineOccurrences: countUserTextOccurrences(BEFORE, normalizedText),
        baselineTailMessageId: sendBaselineTailMessageId(BEFORE),
        baselineResolved: true,
        baselineUnsentMessageIds: sendBaselineUnsentMessageIds(BEFORE)
      },
      'later'
    ).pending
    expect(retireLandedMobileNativeChatPending(AFTER, pending ?? [], new Set())).toEqual([])
  })
})

// A send made before the chat's first read settled takes its boundary from that read, which can
// already hold the send's own row, shown as not sent: the boundary is the row before it.
describe('a phone send made before the first read, whose own row it already shows as not sent', () => {
  it('takes the row before it as its boundary, so its own row settles it', () => {
    const pending =
      appendMobileNativeChatPending(
        {},
        'pending',
        'pending-1',
        {
          draftKey: 'draft',
          draftEditGeneration: 0,
          pendingKey: 'pending',
          normalizedText: normalizeReconcileText('later'),
          baselineOccurrences: 0,
          baselineTailMessageId: null,
          baselineResolved: false
        },
        'later'
      ).pending ?? []
    const read = phone(
      [...BEFORE_ITEMS, user('m2', 21, 'later')],
      [
        REJECTED,
        submission('m2', 'later', 20, {
          dispatchState: 'rejected',
          providerItemId: null,
          reason: 'provider_write_failed: broken pipe',
          resolvedAt: 21
        })
      ]
    )
    const rebased = rebaseMobileNativeChatPendingBaselines(read, pending)
    expect(rebased[0]?.baselineTailMessageId).toBe('hi')
    expect(retireLandedMobileNativeChatPending(read, rebased, new Set())).toEqual([])
  })
})

// A captioned image send's placeholder retires only once its local preview binds to its row, so the
// image matcher must apply the same rule: its own not-sent row binds it, an older one doesn't.
describe('a captioned image send whose own row turns not sent', () => {
  const CAPTION = 'look at this'
  function imageRow(id: string, unsent: boolean): NativeChatMessage {
    return {
      id,
      role: 'user',
      source: 'transcript',
      timestamp: null,
      blocks: [
        { type: 'text', text: CAPTION },
        { type: 'image-ref', path: '/tmp/x.png' }
      ],
      ...(unsent ? { unsent: true as const } : {})
    }
  }
  const HELLO: NativeChatMessage = {
    id: 'a1',
    role: 'assistant',
    source: 'transcript',
    timestamp: null,
    blocks: [{ type: 'text', text: 'Hello' }]
  }

  function placeholderLeft(before: NativeChatMessage[], after: NativeChatMessage[]): number {
    const normalizedText = normalizeReconcileText(CAPTION)
    const pending =
      appendMobileNativeChatPending(
        {},
        'pending',
        'pending-1',
        {
          draftKey: 'draft',
          draftEditGeneration: 0,
          pendingKey: 'pending',
          normalizedText,
          baselineOccurrences: countUserTextOccurrences(before, normalizedText),
          baselineTailMessageId: sendBaselineTailMessageId(before),
          baselineResolved: true,
          baselineUnsentMessageIds: sendBaselineUnsentMessageIds(before)
        },
        CAPTION,
        ['file:///local.png']
      ).pending ?? []
    const landed = findLandedImagePreviewEchoes(after, pending)
    return retireLandedMobileNativeChatPending(
      after,
      pending,
      new Set(landed.map((preview) => preview.pendingId))
    ).length
  }

  it('retires its placeholder on its own not-sent row', () => {
    expect(placeholderLeft([HELLO], [HELLO, imageRow('m2', true)])).toBe(0)
  })

  // An image-only send whose preview is gone is counted by its image turns after the send's tail;
  // an older not-sent one can sit past that tail, at its journal place.
  it('never counts an older not-sent image turn for a textless send', () => {
    const imageOnly = (id: string, unsent: boolean): NativeChatMessage => ({
      ...imageRow(id, unsent),
      blocks: [{ type: 'text', text: '[Image: source: /tmp/x.png]' }]
    })
    const before = [HELLO, imageOnly('m1', true)]
    const pending =
      appendMobileNativeChatPending(
        {},
        'pending',
        'pending-1',
        {
          draftKey: 'draft',
          draftEditGeneration: 0,
          pendingKey: 'pending',
          normalizedText: '',
          baselineOccurrences: 0,
          baselineTailMessageId: sendBaselineTailMessageId(before),
          baselineResolved: true,
          baselineUnsentMessageIds: sendBaselineUnsentMessageIds(before)
        },
        ''
      ).pending ?? []
    expect(retireLandedMobileNativeChatPending(before, pending, new Set())).toHaveLength(1)
    expect(
      retireLandedMobileNativeChatPending([...before, imageOnly('m2', true)], pending, new Set())
    ).toEqual([])
  })

  it('keeps it while only a not-sent copy from before the send is there', () => {
    const before = [HELLO, imageRow('m1', true)]
    expect(placeholderLeft(before, before)).toBe(1)
    expect(placeholderLeft(before, [...before, imageRow('m2', true)])).toBe(0)
  })
})
