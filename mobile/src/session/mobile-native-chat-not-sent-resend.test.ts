// The phone draws a message the host recorded and then rejected in place, as not sent. The user's
// way on is to send its text again, as a new message; the not-sent original stays where it was. The
// phone's own echo of that resend must land on the new copy alone, never on the original.

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
  findLandedUnconfirmedSends,
  normalizeReconcileText,
  sendBaselineTailMessageId,
  sendBaselineUnsentMessageIds
} from './mobile-native-chat-draft-reconcile'
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
  return projectStructuredAgentSessionMessages(items, [], submissions, {
    rejectedInPlace: true,
    queuedMessageIds: []
  })
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
  it('ends as the not-sent original plus the delivered resend, with no echo left', () => {
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
    ).toEqual([true, false])
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

  it('keeps a not-sent row where the host placed it, above what came after', () => {
    const items = [
      user('m1', 11, 'hello'),
      user('m3', 20, 'are you there?'),
      answer('a3', 21, 'Yes')
    ]
    const messages = phone(items, [
      { ...REJECTED, payloadFingerprint: 'body:hello' },
      submission('m3', 'are you there?', 20)
    ])
    expect(messages.map((message) => [message.id, message.unsent ?? false])).toEqual([
      [agentJournalSubmissionKey('m1'), true],
      [agentJournalSubmissionKey('m3'), false],
      ['a3', false]
    ])
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
