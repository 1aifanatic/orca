// Which delivery lines read muted: a plain "not sent" does, a line still in doubt keeps the error
// color, so nothing turns from red to muted and no doubt reads as settled.

import { describe, expect, it, vi } from 'vitest'
import { agentJournalSubmissionKey } from '../../../../shared/agent-session-journal-item-key'
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

const NOT_FAILED_HERE: ReadonlySet<string> = new Set()

describe('the tone of a delivery line', () => {
  // Only a plain "not sent" reads muted, the host's copy until its row loads included, so nothing
  // turns from red to muted; a doubt still reads as one to check.
  it('marks as not sent only words that say the message did not go out', () => {
    const notices = structuredAgentSessionDeliveryNotices(
      [
        entry('doubt', { state: 'unconfirmed', retryAfterUnknownSubmittedAt: -1 }),
        entry('expired', {
          lastAttemptAt: 1,
          lastFailure: { kind: 'refused', code: 'agent_session_operation_expired' }
        }),
        entry('hostCopy', { state: 'rejected', lastFailure: { kind: 'rejected', reason: null } }),
        entry('held', {
          lastFailure: { kind: 'refused', code: 'agent_session_owner_restart_failed' }
        })
      ],
      'Claude',
      vi.fn(),
      [
        {
          clientMessageId: 'elsewhere',
          fence: 1,
          payloadFingerprint: 'fingerprint',
          dispatchState: 'rejected',
          providerItemId: null,
          reason: 'not_delivered',
          submittedAt: 1,
          resolvedAt: 1
        }
      ],
      [],
      NOT_FAILED_HERE
    )
    expect(
      Object.fromEntries([...notices].map(([id, notice]) => [id, notice.notSent === true]))
    ).toEqual({
      [agentJournalSubmissionKey('doubt')]: false,
      [agentJournalSubmissionKey('expired')]: false,
      [agentJournalSubmissionKey('hostCopy')]: true,
      [agentJournalSubmissionKey('held')]: true,
      [agentJournalSubmissionKey('elsewhere')]: true
    })
  })

  // A resend of an id still running: the host can't say what became of it, so it may have landed.
  it("keeps a send the host couldn't confirm in the doubt color, seen here or not", () => {
    const unknown = entry('unknown', {
      lastAttemptAt: 1,
      lastFailure: { kind: 'refused', code: 'agent_session_operation_unknown' }
    })
    for (const failedHere of [new Set(['unknown']), NOT_FAILED_HERE]) {
      const notice = structuredAgentSessionDeliveryNotices(
        [unknown],
        'Claude',
        vi.fn(),
        [],
        [],
        failedHere
      ).get(agentJournalSubmissionKey('unknown'))
      expect(notice?.notSent).toBeUndefined()
    }
    expect(
      structuredAgentSessionDeliveryNotices(
        [unknown],
        'Claude',
        vi.fn(),
        [],
        [],
        new Set(['unknown'])
      ).get(agentJournalSubmissionKey('unknown'))?.text
    ).toBe("Orca couldn't confirm what happened. Check the chat.")
  })
})
