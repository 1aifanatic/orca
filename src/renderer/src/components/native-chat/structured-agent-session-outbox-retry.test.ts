// @vitest-environment happy-dom

// On a host that cannot queue a message again in place, this desktop's Retry sends it again as a
// new message. The rejected original stays in the journal, so the desktop retires its id: the chat
// never draws it beside its resend, across a restart too.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalSubmission } from '../../../../shared/agent-session-journal-types'
import { createStructuredAgentSessionOutboxEntry } from '../../../../shared/structured-agent-session-outbox'
import { retryStructuredAgentSessionOutboxEntry } from './structured-agent-session-outbox-retry'
import {
  commitStructuredAgentSessionOutbox,
  getStructuredAgentSessionOutbox,
  readRetiredStructuredAgentSessionMessageIds
} from './structured-agent-session-outbox-storage'

const SESSION = 'session-a'
const OLD = '1759312345678-0123456789abcdef0123456789abcdef'
const NEW = '1759312345999-fedcba9876543210fedcba9876543210'

const rejected: AgentJournalSubmission = {
  clientMessageId: OLD,
  fence: 1,
  payloadFingerprint: 'fp',
  dispatchState: 'rejected',
  providerItemId: null,
  reason: 'Codex stopped before it finished starting.',
  submittedAt: 1,
  resolvedAt: 2,
  handoverRecorded: true
}

describe("this desktop's Retry of its own rejected message, as a new one", () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('sends it under a new id and retires the old one here', () => {
    commitStructuredAgentSessionOutbox(SESSION, [
      {
        ...createStructuredAgentSessionOutboxEntry({
          clientMessageId: OLD,
          sessionId: SESSION,
          text: 'hello',
          attachments: [],
          queuedAt: 1
        }),
        state: 'rejected'
      }
    ])

    retryStructuredAgentSessionOutboxEntry({
      clientMessageId: OLD,
      sessionId: SESSION,
      submissions: [rejected],
      setError: vi.fn(),
      createOperationId: () => NEW
    })

    expect(getStructuredAgentSessionOutbox(SESSION)).toEqual([
      expect.objectContaining({ clientMessageId: NEW, state: 'queued' })
    ])
    expect([...readRetiredStructuredAgentSessionMessageIds(SESSION)]).toEqual([OLD])
  })

  it('retires nothing when this desktop holds no such message', () => {
    retryStructuredAgentSessionOutboxEntry({
      clientMessageId: OLD,
      sessionId: SESSION,
      submissions: [rejected],
      setError: vi.fn(),
      createOperationId: () => NEW
    })

    expect(readRetiredStructuredAgentSessionMessageIds(SESSION).size).toBe(0)
  })
})
