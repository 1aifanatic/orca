// A message this client did not send — the host's own restart continuation, a phone's, an
// orchestration worker's first — whose start failed for good still shows in the chat, saying why.

import { describe, expect, it, vi } from 'vitest'
import { agentSessionFailureWords } from '../../../../shared/agent-session-failure-words'
import { agentJournalSubmissionKey } from '../../../../shared/agent-session-journal-item-key'
import type {
  AgentJournalMessageItem,
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session-journal-types'
import type { SubmissionRejectionFact } from '../../../../shared/agent-session-failure'
import { projectStructuredAgentSessionMessages } from '../../../../shared/structured-agent-session-message-projection'
import { resendableFailedStartsSentElsewhere } from '../../../../shared/structured-agent-session-failed-start-elsewhere'
import { createStructuredAgentSessionOutboxEntry } from '../../../../shared/structured-agent-session-outbox'
import { structuredAgentSessionDeliveryNotices } from './structured-agent-session-delivery-notices'

const ID = '1759312345678-0123456789abcdef0123456789abcdef'
const KEY = agentJournalSubmissionKey(ID)

function item(body: AgentJournalMessageItem): AgentJournalRenderItem {
  return { itemId: KEY, revision: 0, sequence: 5, observedAt: 5, body }
}
const TEXT = item({
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text: 'Continue where you left off' }]
})

function rejected(fact: SubmissionRejectionFact): AgentJournalSubmission {
  return {
    clientMessageId: ID,
    fence: 1,
    payloadFingerprint: 'fp',
    dispatchState: 'rejected',
    providerItemId: null,
    submittedAt: 4,
    resolvedAt: 7,
    handoverRecorded: true,
    ...agentSessionFailureWords(fact, { surface: 'rejection', agentName: 'Codex' })
  }
}

describe('a message sent from elsewhere whose start failed for good', () => {
  it.each([
    [{ kind: 'providerStartFailed' }, 'Codex stopped before it finished starting.'],
    [{ kind: 'hostFault' }, "Orca ran into a problem, so this didn't go through."],
    [{ kind: 'notSignedIn' }, 'Codex is not signed in for the selected account. Sign in first.']
  ] as const)('shows as unsent, says why %j, and offers a Retry', (fact, why) => {
    const submissions = [rejected(fact)]
    const retry = vi.fn()
    const resendable = resendableFailedStartsSentElsewhere([TEXT], submissions, [])

    expect(projectStructuredAgentSessionMessages([TEXT], [], submissions)).toEqual([
      expect.objectContaining({ id: KEY, unsent: true })
    ])
    const notice = structuredAgentSessionDeliveryNotices(
      [],
      'Codex',
      retry,
      submissions,
      [],
      new Set(),
      (id) => resendable.has(id)
    ).get(KEY)
    expect(notice?.text).toBe(why)
    notice?.onRetry?.()
    expect(retry).toHaveBeenCalledWith(ID)
    expect(resendable.get(ID)).toBe('Continue where you left off')
  })

  // The phone draws rows in the order the projection gives them; only the desktop sorts.
  it('is placed where the journal recorded it, above what came after it', () => {
    const exchange = (id: string, sequence: number, role: 'user' | 'assistant') => ({
      itemId: role === 'user' ? agentJournalSubmissionKey(id) : `codex:${id}`,
      revision: 0,
      sequence,
      observedAt: sequence,
      body: { kind: 'message' as const, role, blocks: [{ type: 'text' as const, text: id }] }
    })
    const accepted = (id: string): AgentJournalSubmission => ({
      ...rejected({ kind: 'providerStartFailed' }),
      clientMessageId: id,
      dispatchState: 'accepted',
      reason: null,
      rejection: undefined
    })
    const later = '1759312345999-0123456789abcdef0123456789abcdef'
    const items = [
      exchange('first', 1, 'user'),
      exchange('first-answer', 2, 'assistant'),
      TEXT,
      exchange(later, 6, 'user'),
      exchange('later-answer', 7, 'assistant')
    ]
    const submissions = [
      accepted('first'),
      rejected({ kind: 'providerStartFailed' }),
      accepted(later)
    ]

    expect(
      projectStructuredAgentSessionMessages(items, [], submissions).map((row) => row.id)
    ).toEqual([
      agentJournalSubmissionKey('first'),
      'codex:first-answer',
      KEY,
      agentJournalSubmissionKey(later),
      'codex:later-answer'
    ])
  })

  it('stays hidden when it failed for anything but its start, as before', () => {
    expect(
      projectStructuredAgentSessionMessages([TEXT], [], [rejected({ kind: 'queueFull' })])
    ).toEqual([])
  })

  it('offers no Retry for one with images, whose files are not on this client', () => {
    const withImage = item({
      kind: 'message',
      role: 'user',
      blocks: [
        { type: 'text', text: 'look' },
        { type: 'image-ref', url: 'orca-image://img-1' }
      ]
    })
    const submissions = [rejected({ kind: 'providerStartFailed' })]
    const resendable = resendableFailedStartsSentElsewhere([withImage], submissions, [])
    expect(resendable.size).toBe(0)
    const notice = structuredAgentSessionDeliveryNotices(
      [],
      'Codex',
      vi.fn(),
      submissions,
      [],
      new Set(),
      (id) => resendable.has(id)
    ).get(KEY)
    expect(notice).toEqual({
      text: 'Codex stopped before it finished starting. Send your message to try again.'
    })
  })
})

// A Retry sends the message again under a new id; the rejected one stays in the journal. The new
// message names it, so no client draws it, or offers its Retry, again.
describe('a message whose start failed for good, after its Retry', () => {
  const RETRY = '1759312345999-fedcba9876543210fedcba9876543210'
  const retryItem: AgentJournalRenderItem = {
    ...TEXT,
    itemId: agentJournalSubmissionKey(RETRY),
    sequence: 9,
    observedAt: 9
  }
  const retrySubmission = (retries?: string): AgentJournalSubmission => ({
    clientMessageId: RETRY,
    fence: 1,
    payloadFingerprint: 'fp',
    dispatchState: 'pending',
    providerItemId: null,
    reason: null,
    submittedAt: 9,
    resolvedAt: null,
    handoverRecorded: true,
    ...(retries ? { retries } : {})
  })

  it('is drawn once, as its Retry, when this desktop retried its own message', () => {
    const retried = {
      ...createStructuredAgentSessionOutboxEntry({
        clientMessageId: RETRY,
        sessionId: 's',
        text: 'Continue where you left off',
        attachments: [],
        queuedAt: 1
      }),
      retries: ID
    }
    const submissions = [rejected({ kind: 'providerStartFailed' }), retrySubmission(ID)]

    expect(
      projectStructuredAgentSessionMessages([TEXT, retryItem], [retried], submissions).map(
        (row) => row.id
      )
    ).toEqual([agentJournalSubmissionKey(RETRY)])
  })

  it('keeps no Retry of its own when another device resent it', () => {
    const submissions = [rejected({ kind: 'providerStartFailed' }), retrySubmission(ID)]

    expect(resendableFailedStartsSentElsewhere([TEXT, retryItem], submissions, []).has(ID)).toBe(
      false
    )
    expect(
      projectStructuredAgentSessionMessages([TEXT, retryItem], [], submissions).map((row) => row.id)
    ).toEqual([agentJournalSubmissionKey(RETRY)])
  })

  it('is still drawn, with its Retry, by a host that did not record what the Retry sent again', () => {
    const submissions = [rejected({ kind: 'providerStartFailed' }), retrySubmission()]

    expect(resendableFailedStartsSentElsewhere([TEXT, retryItem], submissions, []).has(ID)).toBe(
      true
    )
  })
})
