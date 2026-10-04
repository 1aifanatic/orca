// Which delivery lines read muted: a message the host recorded and did not deliver reads muted,
// from its row or from this client's copy until that row loads, so nothing turns from one tone to
// the other. A message still on its way reads only as sending, with no words.

import { describe, expect, it } from 'vitest'
import { agentJournalSubmissionKey } from '../../../../shared/agent-session-journal-item-key'
import type { AgentJournalSubmission } from '../../../../shared/agent-session-journal-types'
import {
  createStructuredAgentSessionOutboxEntry,
  type StructuredAgentSessionOutboxEntry
} from '../../../../shared/structured-agent-session-outbox'
import { structuredAgentSessionDeliveryNotices } from './structured-agent-session-delivery-notices'

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

function rejected(clientMessageId: string): AgentJournalSubmission {
  return {
    clientMessageId,
    fence: 1,
    payloadFingerprint: clientMessageId,
    dispatchState: 'rejected',
    providerItemId: null,
    reason: 'not_delivered',
    submittedAt: 1,
    resolvedAt: 1
  }
}

describe('the tone of a delivery line', () => {
  it("reads muted for every message the host didn't deliver, and only as sending for one on its way", () => {
    const notices = structuredAgentSessionDeliveryNotices(
      [
        entry('queued'),
        entry('resent', { state: 'unconfirmed', lastAttemptAt: 1 }),
        // The host rejected it and its row is not loaded: this copy draws it until then.
        entry('hostCopy', { state: 'dispatching', lastAttemptAt: 1 })
      ],
      'Claude',
      [rejected('hostCopy'), rejected('elsewhere')],
      []
    )

    expect(
      Object.fromEntries(
        [...notices].map(([id, notice]) => [
          id,
          notice.sending === true ? 'sending' : notice.muted === true ? 'muted' : 'error'
        ])
      )
    ).toEqual({
      [agentJournalSubmissionKey('queued')]: 'sending',
      [agentJournalSubmissionKey('resent')]: 'sending',
      [agentJournalSubmissionKey('hostCopy')]: 'muted',
      [agentJournalSubmissionKey('elsewhere')]: 'muted'
    })
  })
})
