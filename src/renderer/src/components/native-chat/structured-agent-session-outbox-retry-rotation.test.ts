// @vitest-environment happy-dom

// A Retry on this client's own message the agent never got sends it again under a new id. The new
// copy is the message: the old row is never drawn beside it, whatever becomes of the copy, and a
// reopen reads the same from the saved outbox.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { agentSessionFailureFact } from '../../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../../shared/agent-session-failure-words'
import { agentJournalSubmissionKey } from '../../../../shared/agent-session-journal-item-key'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session-journal-types'
import { projectStructuredAgentSessionMessages } from '../../../../shared/structured-agent-session-message-projection'
import {
  createStructuredAgentSessionOutboxEntry,
  reconcileStructuredAgentSessionOutbox,
  type StructuredAgentSessionOutboxEntry
} from '../../../../shared/structured-agent-session-outbox'
import { structuredAgentSessionDeliveryNotices } from './structured-agent-session-delivery-notices'
import { retryStructuredAgentSessionOutboxEntry } from './structured-agent-session-outbox-retry'
import {
  getStructuredAgentSessionOutbox,
  readOutbox,
  writeOutbox
} from './structured-agent-session-outbox-storage'

const SESSION = 'session-1'
const ORIGINAL = 'op-original'
const COPY = 'op-copy'

const ITEM: AgentJournalRenderItem = {
  itemId: agentJournalSubmissionKey(ORIGINAL),
  revision: 0,
  sequence: 5,
  observedAt: 5,
  body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hello' }] }
}

const UNDELIVERED: AgentJournalSubmission = {
  clientMessageId: ORIGINAL,
  fence: 1,
  payloadFingerprint: 'fingerprint',
  dispatchState: 'rejected',
  providerItemId: null,
  submittedAt: 4,
  resolvedAt: 7,
  handoverRecorded: true,
  handedOverAt: 5,
  recovered: true,
  ...agentSessionFailureWords(agentSessionFailureFact('notDelivered'), { surface: 'rejection' })
}

function copyRow(patch: Partial<AgentJournalSubmission>): AgentJournalSubmission {
  return {
    ...UNDELIVERED,
    clientMessageId: COPY,
    dispatchState: 'pending',
    reason: null,
    rejection: undefined,
    submittedAt: 9,
    resolvedAt: null,
    handedOverAt: undefined,
    recovered: undefined,
    ...patch
  }
}

/** What the chat draws: each row's id, and the ids that carry a notice. */
function drawn(
  outbox: readonly StructuredAgentSessionOutboxEntry[],
  submissions: AgentJournalSubmission[]
) {
  return {
    rows: projectStructuredAgentSessionMessages([ITEM], outbox, submissions).map(({ id }) => id),
    noticed: [
      ...structuredAgentSessionDeliveryNotices(
        outbox,
        'Claude',
        vi.fn(),
        submissions,
        [],
        new Set()
      ).keys()
    ]
  }
}

describe("a Retry on this client's own message the agent never got", () => {
  let afterRetry: StructuredAgentSessionOutboxEntry[]

  beforeEach(() => {
    localStorage.clear()
    const own = reconcileStructuredAgentSessionOutbox(
      [
        {
          ...createStructuredAgentSessionOutboxEntry({
            clientMessageId: ORIGINAL,
            sessionId: SESSION,
            text: 'hello',
            attachments: [],
            queuedAt: 4
          }),
          state: 'dispatching',
          lastAttemptAt: 4
        }
      ],
      [UNDELIVERED]
    )
    writeOutbox(SESSION, own)
    retryStructuredAgentSessionOutboxEntry({
      clientMessageId: ORIGINAL,
      sessionId: SESSION,
      submissions: [UNDELIVERED],
      setError: vi.fn(),
      createOperationId: () => COPY
    })
    afterRetry = getStructuredAgentSessionOutbox(SESSION)
  })

  it('draws only the copy while it waits to go out, and after a reopen', () => {
    expect(afterRetry).toMatchObject([{ clientMessageId: COPY, rotatedFrom: [ORIGINAL] }])
    const copyKey = agentJournalSubmissionKey(COPY)
    expect(drawn(afterRetry, [UNDELIVERED])).toEqual({ rows: [copyKey], noticed: [] })
    // The saved outbox remembers the id it replaced.
    expect(drawn(readOutbox(SESSION), [UNDELIVERED])).toEqual({ rows: [copyKey], noticed: [] })
  })

  it.each<[string, Partial<AgentJournalSubmission>]>([
    ['recorded and waiting behind a turn', {}],
    ['handed over', { handedOverAt: 10 }]
  ])('never draws the old row beside the copy once it is %s', (_case, patch) => {
    const submissions = [UNDELIVERED, copyRow(patch)]
    const outbox = reconcileStructuredAgentSessionOutbox(afterRetry, submissions)
    expect(drawn(outbox, submissions).noticed).toEqual([])
    expect(drawn(outbox, submissions).rows).not.toContain(agentJournalSubmissionKey(ORIGINAL))
  })

  it('never draws the old row beside a copy the host refused', () => {
    const refused = afterRetry.map((entry) => ({
      ...entry,
      lastAttemptAt: 9,
      lastFailure: { kind: 'refused' as const, code: 'agent_session_journal_unreadable' as const }
    }))
    expect(drawn(refused, [UNDELIVERED])).toEqual({
      rows: [agentJournalSubmissionKey(COPY)],
      noticed: [agentJournalSubmissionKey(COPY)]
    })
  })
})
