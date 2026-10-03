// A message in doubt holds the queue only while the host may never have received it: once the
// journal holds it, its place is fixed and the host never sends it again.

import { describe, expect, it } from 'vitest'
import type { AgentJournalSubmission } from './agent-session-journal-types'
import {
  createStructuredAgentSessionOutboxEntry,
  reconcileStructuredAgentSessionOutbox,
  type StructuredAgentSessionOutboxEntry
} from './structured-agent-session-outbox'
import { admitStructuredAgentSessionOutboxEntry } from './structured-agent-session-outbox-admission'

function entry(
  clientMessageId: string,
  patch: Partial<StructuredAgentSessionOutboxEntry> = {}
): StructuredAgentSessionOutboxEntry {
  return {
    ...createStructuredAgentSessionOutboxEntry({
      clientMessageId,
      sessionId: 'session-1',
      text: clientMessageId,
      attachments: [],
      queuedAt: 1
    }),
    ...patch
  }
}

function unknown(clientMessageId: string, recovered: boolean): AgentJournalSubmission {
  return {
    clientMessageId,
    fence: 1,
    payloadFingerprint: 'fingerprint',
    dispatchState: 'unknown',
    providerItemId: null,
    reason: 'provider_closed_before_acknowledgement',
    submittedAt: 5,
    resolvedAt: 6,
    ...(recovered ? { recovered: true as const } : {})
  }
}

describe('a message in doubt', () => {
  it.each([
    ['outlived its writer', true],
    ['is still outstanding', false]
  ] as const)(
    'holds nothing up once the journal holds it, whether its doubt %s',
    (_case, recovered) => {
      const submissions = [unknown('doubt', recovered)]
      const outbox = reconcileStructuredAgentSessionOutbox(
        [entry('doubt', { state: 'dispatching', lastAttemptAt: 2 }), entry('next')],
        submissions
      )
      expect(outbox[0]?.state).toBe('unconfirmed')
      expect(admitStructuredAgentSessionOutboxEntry(outbox, submissions)).toEqual({
        state: 'dispatch',
        entry: outbox[1]
      })
    }
  )

  it('holds the queue while the host may never have received it', () => {
    const outbox = [entry('doubt', { state: 'unconfirmed', lastAttemptAt: 2 }), entry('next')]
    expect(admitStructuredAgentSessionOutboxEntry(outbox, [])).toEqual({
      state: 'blocked',
      entry: outbox[0]
    })
    // Another message's row says nothing about this one.
    expect(admitStructuredAgentSessionOutboxEntry(outbox, [unknown('other', true)])).toEqual({
      state: 'blocked',
      entry: outbox[0]
    })
  })

  it('stops the queue on one the host may not have, behind one it holds', () => {
    const outbox = [
      entry('held', { state: 'unconfirmed', lastAttemptAt: 2 }),
      entry('lost', { state: 'unconfirmed', lastAttemptAt: 3 }),
      entry('next')
    ]
    expect(admitStructuredAgentSessionOutboxEntry(outbox, [unknown('held', true)])).toEqual({
      state: 'blocked',
      entry: outbox[1]
    })
  })

  // Nothing about it changed, so a streamed batch neither rewrites the saved outbox nor redraws it.
  it('is kept as it is by every reconcile while it stays in doubt', () => {
    const inDoubt = entry('doubt', { state: 'unconfirmed', lastAttemptAt: 2 })
    const [reconciled] = reconcileStructuredAgentSessionOutbox([inDoubt], [unknown('doubt', true)])
    expect(reconciled).toBe(inDoubt)
  })
})
