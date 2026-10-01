// @vitest-environment happy-dom

// On a host that cannot queue a message again in place, this desktop's Retry sends it again as a
// new message. The rejected original stays in the journal, so the desktop retires its id: the chat
// never draws it beside its resend, across a restart too.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session-journal-types'
import {
  createStructuredAgentSessionOutboxEntry,
  type StructuredAgentSessionOutboxEntry
} from '../../../../shared/structured-agent-session-outbox'
import { agentSessionFailureFact } from '../../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../../shared/agent-session-failure-words'
import { agentJournalSubmissionKey } from '../../../../shared/agent-session-journal-item-key'
import { retryableFailedStartsSentElsewhere } from '../../../../shared/structured-agent-session-failed-start-elsewhere'
import { projectStructuredAgentSessionMessages } from '../../../../shared/structured-agent-session-message-projection'
import { structuredAgentSessionDeliveryNotices } from './structured-agent-session-delivery-notices'
import { retryStructuredAgentSessionOutboxEntry } from './structured-agent-session-outbox-retry'
import {
  commitStructuredAgentSessionOutbox,
  getStructuredAgentSessionOutbox,
  readOutbox,
  readRetiredStructuredAgentSessionMessageIds,
  withoutRetiredStructuredAgentSessionMessages
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

// The copy's original is still rejected in the journal and missing from this desktop's outbox, so
// once the host can queue a message again in place it would read as one sent elsewhere, with a live
// Retry: the same words delivered twice. Retired here, it never comes back.
describe("the original of a copy this desktop's Retry sent to an older host", () => {
  const KEY = agentJournalSubmissionKey(OLD)
  const items: AgentJournalRenderItem[] = [
    {
      itemId: KEY,
      revision: 0,
      sequence: 5,
      observedAt: 5,
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hello' }] }
    }
  ]
  const failedStart: AgentJournalSubmission = {
    ...rejected,
    ...agentSessionFailureWords(agentSessionFailureFact('providerStartFailed'), {
      surface: 'rejection',
      agentName: 'Codex'
    })
  }

  /** What the chat draws and offers a Retry for, from what is persisted, on a host that can now
   *  queue a message again in place. */
  function chatOnCapableHost(outbox: StructuredAgentSessionOutboxEntry[]) {
    const shown = withoutRetiredStructuredAgentSessionMessages(
      { items, submissions: [failedStart] },
      readRetiredStructuredAgentSessionMessageIds(SESSION)
    )
    const { submissions } = shown
    const retryable = retryableFailedStartsSentElsewhere(submissions, outbox)
    return {
      rows: projectStructuredAgentSessionMessages(shown.items, outbox, submissions).map(
        (row) => row.id
      ),
      original: structuredAgentSessionDeliveryNotices(
        outbox,
        'Codex',
        vi.fn(),
        submissions,
        [],
        new Set(),
        (id) => retryable.has(id)
      ).get(KEY),
      retryable
    }
  }

  beforeEach(() => {
    localStorage.clear()
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
    // The older host: Retry sends a copy.
    retryStructuredAgentSessionOutboxEntry({
      clientMessageId: OLD,
      sessionId: SESSION,
      submissions: [failedStart],
      setError: vi.fn(),
      createOperationId: () => NEW
    })
  })

  it('stays hidden, with no Retry, once the host can queue it again', () => {
    const chat = chatOnCapableHost(getStructuredAgentSessionOutbox(SESSION))

    expect(chat.rows).toEqual([agentJournalSubmissionKey(NEW)])
    expect(chat.retryable.has(OLD)).toBe(false)
    expect(chat.original).toBeUndefined()
  })

  it('stays hidden after the app restarts and reloads what it persisted', () => {
    // A restart holds nothing in memory: the outbox and the retired ids come back from storage.
    const chat = chatOnCapableHost(readOutbox(SESSION))

    expect(chat.rows).toEqual([agentJournalSubmissionKey(NEW)])
    expect(chat.retryable.has(OLD)).toBe(false)
  })
})
