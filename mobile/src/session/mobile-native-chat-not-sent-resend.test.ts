// The phone draws a message the host recorded and then rejected in place, as not sent. The user's
// way on is to send its text again, after which the host hides the not-sent original: the phone's
// own echo of that resend must land on the new copy alone.

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
  sendBaselineTailMessageId
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
  it('ends as exactly one bubble once the resend lands', () => {
    const before = phone(BEFORE_ITEMS, [REJECTED])
    const normalizedText = normalizeReconcileText(TEXT)
    const origin = {
      draftKey: 'draft',
      draftEditGeneration: 0,
      pendingKey: 'pending',
      normalizedText,
      baselineOccurrences: countUserTextOccurrences(before, normalizedText),
      baselineTailMessageId: sendBaselineTailMessageId(before),
      baselineResolved: true
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
        deadline: null
      }
    ])
    expect(landed).toHaveLength(1)
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
