// The view's reading of the outbox runs on every journal batch, so reading an unchanged journal
// again must change nothing: the same entries, and the same list.

import { expect, it } from 'vitest'
import { agentJournalSubmissionKey } from './agent-session-journal-item-key'
import type {
  AgentJournalDispatchState,
  AgentJournalRenderItem,
  AgentJournalSubmission
} from './agent-session-journal-types'
import {
  createStructuredAgentSessionOutboxEntry,
  reconcileStructuredAgentSessionOutbox,
  type StructuredAgentSessionOutboxEntry
} from './structured-agent-session-outbox'

function entry(
  id: string,
  patch: Partial<StructuredAgentSessionOutboxEntry> = {}
): StructuredAgentSessionOutboxEntry {
  return {
    ...createStructuredAgentSessionOutboxEntry({
      clientMessageId: id,
      sessionId: 'session-1',
      text: id,
      attachments: [],
      queuedAt: 1
    }),
    ...patch
  }
}

function submission(id: string, dispatchState: AgentJournalDispatchState): AgentJournalSubmission {
  return {
    clientMessageId: id,
    fence: 1,
    payloadFingerprint: id,
    dispatchState,
    providerItemId: null,
    reason: dispatchState === 'unknown' ? 'in doubt' : null,
    ...(dispatchState === 'rejected' ? { rejection: { kind: 'hostRestarted' } } : {}),
    submittedAt: 5,
    resolvedAt: dispatchState === 'pending' ? null : 6
  }
}

function row(id: string): AgentJournalRenderItem {
  return {
    itemId: agentJournalSubmissionKey(id),
    revision: 1,
    sequence: 1,
    observedAt: 1,
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: id }] }
  }
}

it("keeps a rejected message's entry only until its row loads, and returns every kept entry, and the list, as themselves when read again", () => {
  const entries = [
    entry('queued'),
    entry('landing', { state: 'unconfirmed' }),
    entry('sending', { state: 'dispatching' }),
    entry('doubt', { state: 'unconfirmed' }),
    entry('rejected-unloaded', { state: 'dispatching' }),
    entry('rejected-loaded', { state: 'dispatching' }),
    entry('delivered', { state: 'dispatching' })
  ]
  const submissions = [
    submission('landing', 'pending'),
    submission('sending', 'pending'),
    submission('doubt', 'unknown'),
    submission('rejected-unloaded', 'rejected'),
    submission('rejected-loaded', 'rejected'),
    submission('delivered', 'accepted')
  ]
  const items = [row('rejected-loaded')]

  const first = reconcileStructuredAgentSessionOutbox(entries, submissions, items)
  expect(first.map((kept) => [kept.clientMessageId, kept.state])).toEqual([
    ['queued', 'queued'],
    ['landing', 'dispatching'],
    ['sending', 'dispatching'],
    ['rejected-unloaded', 'dispatching']
  ])
  const second = reconcileStructuredAgentSessionOutbox(first, submissions, items)
  expect(second).toBe(first)
  second.forEach((kept, index) => expect(kept).toBe(first[index]))
})

it('returns the list it was given when nothing changes', () => {
  const entries = [entry('queued'), entry('sending', { state: 'dispatching' })]
  expect(
    reconcileStructuredAgentSessionOutbox(entries, [submission('sending', 'pending')], [])
  ).toBe(entries)
})
