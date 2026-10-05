// A send the host withdrew (a Stop took it back before it ran) leaves the outbox with no notice, so
// the next queued send goes out. One the host recorded in doubt leaves it too: its row draws it, and
// the host never sends it again.

import { describe, expect, it } from 'vitest'
import { agentSessionFailureFact } from './agent-session-failure'
import { agentSessionFailureWords } from './agent-session-failure-words'
import type { AgentJournalSubmission } from './agent-session-journal-types'
import {
  createStructuredAgentSessionOutboxEntry,
  type StructuredAgentSessionOutboxEntry
} from './structured-agent-session-outbox'
import { reconcileStructuredAgentSessionOutbox } from './structured-agent-session-outbox-reconcile'
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

function submission(patch: Partial<AgentJournalSubmission>): AgentJournalSubmission {
  return {
    clientMessageId: 'stopped',
    fence: 1,
    payloadFingerprint: 'fingerprint',
    dispatchState: 'pending',
    providerItemId: null,
    reason: null,
    submittedAt: 1,
    resolvedAt: 2,
    ...patch
  }
}

const OUTBOX = [entry('stopped', { state: 'dispatching', lastAttemptAt: 1 }), entry('next')]

describe('the send a Stop ended before its turn opened', () => {
  it('leaves the outbox when withdrawn, and the next send goes out', () => {
    const withdrawn = submission({
      dispatchState: 'rejected',
      recovered: true,
      ...agentSessionFailureWords(agentSessionFailureFact('cancelled'), { surface: 'rejection' })
    })

    const reconciled = reconcileStructuredAgentSessionOutbox(OUTBOX, [withdrawn], [])

    expect(reconciled.map((each) => each.clientMessageId)).toEqual(['next'])
    expect(admitStructuredAgentSessionOutboxEntry(reconciled)).toMatchObject({
      state: 'dispatch',
      entry: { clientMessageId: 'next' }
    })
  })

  it('leaves the outbox when recorded in doubt, and the next send goes out', () => {
    const inDoubt = submission({
      dispatchState: 'unknown',
      recovered: true,
      reason: 'provider_closed_before_acknowledgement'
    })

    const reconciled = reconcileStructuredAgentSessionOutbox(OUTBOX, [inDoubt], [])

    expect(reconciled.map((each) => each.clientMessageId)).toEqual(['next'])
    expect(admitStructuredAgentSessionOutboxEntry(reconciled)).toMatchObject({
      state: 'dispatch',
      entry: { clientMessageId: 'next' }
    })
  })
})
