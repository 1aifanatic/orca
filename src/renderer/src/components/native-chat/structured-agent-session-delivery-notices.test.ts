import { describe, expect, it } from 'vitest'
import type { AgentSessionFailureFact } from '../../../../shared/agent-session-failure'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session-journal-types'
import {
  createStructuredAgentSessionOutboxEntry,
  type StructuredAgentSessionOutboxEntry
} from '../../../../shared/structured-agent-session-outbox'
import { agentSessionFailureWords } from '../../../../shared/agent-session-failure-words'
import {
  agentJournalItemKey,
  agentJournalSubmissionKey
} from '../../../../shared/agent-session-journal-item-key'
import { structuredAgentSessionStartFailureRowIdentity } from '../../../../shared/structured-agent-session-start-failure-row-key'
import { structuredAgentSessionStartFailureFacts } from '../../../../shared/structured-agent-session-recorded-rejection-words'
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

function row(
  clientMessageId: string,
  dispatchState: AgentJournalSubmission['dispatchState'],
  patch: Partial<AgentJournalSubmission> = {}
): AgentJournalSubmission {
  return {
    clientMessageId,
    fence: 1,
    // Each its own body: a later copy of the same body would supersede a rejected one.
    payloadFingerprint: `fp-${clientMessageId}`,
    dispatchState,
    providerItemId: null,
    reason: null,
    submittedAt: 1,
    resolvedAt: null,
    ...patch
  }
}

// What the row shows, quietly in place of its time, while nothing has confirmed the message.
const SENDING = 'Sending…'
const NOT_CONFIRMED = "Not confirmed. Send it again if the agent didn't answer it."

function texts(
  outbox: StructuredAgentSessionOutboxEntry[],
  submissions: readonly AgentJournalSubmission[] = [],
  startFailures: readonly AgentSessionFailureFact[] = [],
  agentActive = false
): Record<string, string> {
  const notices = structuredAgentSessionDeliveryNotices(
    outbox,
    'Claude',
    submissions,
    startFailures,
    undefined,
    agentActive
  )
  return Object.fromEntries(
    [...notices].map(([id, notice]) => [id, notice.sending ? SENDING : notice.text])
  )
}

describe('a message still in the outbox', () => {
  // Nothing in the outbox has failed: a send that ends leaves it. Whatever it waits on, it reads
  // as sending until the host holds a row for it, and never offers a Retry.
  it('reads as sending in every state it can wait in', () => {
    const outbox = [
      entry('queued'),
      entry('sending', { state: 'dispatching', lastAttemptAt: 1 }),
      entry('resent', { state: 'unconfirmed', lastAttemptAt: 1 }),
      entry('stopped', {
        state: 'unconfirmed',
        lastAttemptAt: 1,
        stoppedBy: { operationId: 'stop-1' }
      })
    ]
    const notices = structuredAgentSessionDeliveryNotices(outbox, 'Claude', [], [])
    expect([...notices.values()]).toEqual(outbox.map(() => ({ sending: true })))
  })

  // It is not being sent: the host's row or the composer it comes back to shows it.
  it('says nothing for a message an older build saved behind its Retry', () => {
    const legacy = [entry('legacy', { legacyUnsettled: true })]
    expect(structuredAgentSessionDeliveryNotices(legacy, 'Claude', [], [])).toEqual(new Map())
  })

  // Any row the host holds for it is the answer; the row itself then shows it.
  it.each(['pending', 'accepted'] as const)(
    'stops reading as sending once the journal holds a %s row for it',
    (dispatchState) => {
      const outbox = [entry('queued'), entry('resent', { state: 'unconfirmed', lastAttemptAt: 1 })]
      expect(texts(outbox, [row('queued', dispatchState), row('resent', dispatchState)])).toEqual(
        {}
      )
    }
  )

  it("reads as sending though another message's row is in the journal", () => {
    expect(texts([entry('mine')], [row('other', 'accepted')])).toEqual({
      [agentJournalSubmissionKey('mine')]: SENDING
    })
  })

  // One state, one surface: a message the host recorded as not sent never also reads as sending.
  it('says only how it ended once the journal rejects it, never that it is sending', () => {
    const notices = structuredAgentSessionDeliveryNotices(
      [entry('m', { state: 'unconfirmed', lastAttemptAt: 1 })],
      'Claude',
      [row('m', 'rejected', { reason: 'not_delivered', resolvedAt: 2 })],
      []
    )
    expect(notices.get(agentJournalSubmissionKey('m'))).toEqual({
      muted: true,
      text: 'Your message was not sent.'
    })
  })
})

describe('a message the host recorded and did not deliver', () => {
  it('says so, muted, on every client, in the words the sender would read', () => {
    const notices = structuredAgentSessionDeliveryNotices(
      [],
      'Claude',
      [row('elsewhere', 'rejected', { reason: 'not_delivered', resolvedAt: 1 })],
      []
    )
    expect(notices.get(agentJournalSubmissionKey('elsewhere'))).toEqual({
      muted: true,
      text: 'Your message was not sent.'
    })
  })

  it('says nothing for a send a Stop withdrew', () => {
    expect(
      texts([], [row('withdrawn', 'rejected', { reason: 'provider_cancelled_before_start' })])
    ).toEqual({})
  })

  it("words a recorded rejection from the journal's fact, whatever reason the host wrote", () => {
    const recorded = (id: string, rejection: AgentSessionFailureFact): AgentJournalSubmission =>
      row(id, 'rejected', { reason: "The agent couldn't be started.", rejection, resolvedAt: 1 })
    const facts: [string, AgentSessionFailureFact, string][] = [
      [
        'gone',
        {
          kind: 'startFailed',
          refusal: {
            code: 'agent_session_identity_required',
            details: { reason: 'recordMissing' }
          }
        },
        "Claude couldn't start. Start a new chat to continue."
      ],
      [
        'claimed',
        {
          kind: 'startFailed',
          refusal: { code: 'agent_session_conflict', details: { reason: 'claimConflicted' } }
        },
        "Claude couldn't start. This chat is still open in a terminal agent. Quit that agent to continue the chat here."
      ],
      [
        'provider',
        { kind: 'providerRejected', detail: { text: 'Image type .bmp', audience: 'person' } },
        'The provider did not accept this message: Image type .bmp.'
      ],
      [
        'logged',
        { kind: 'providerRejected', detail: { text: 'HTTP 400 at /v1', audience: 'log' } },
        'The provider did not accept this message.'
      ]
    ]
    expect(
      texts(
        [],
        facts.map(([id, fact]) => recorded(id, fact))
      )
    ).toEqual(
      Object.fromEntries(facts.map(([id, , shown]) => [agentJournalSubmissionKey(id), shown]))
    )
  })

  // Matched on the typed fact of a row found by its identity, never on either sentence.
  describe('rejected by a start whose row already says why', () => {
    const startFailed: AgentSessionFailureFact = {
      kind: 'startFailed',
      refusal: { code: 'agent_session_identity_required', details: { reason: 'recordMissing' } }
    }
    const recorded = (id: string, fact: AgentSessionFailureFact): AgentJournalSubmission =>
      row(id, 'rejected', { reason: 'Written by the host.', rejection: fact, resolvedAt: 1 })
    const statusRow = (itemId: string, fact: AgentSessionFailureFact): AgentJournalRenderItem => ({
      itemId,
      revision: 1,
      sequence: 1,
      observedAt: 1,
      body: {
        kind: 'status',
        tone: 'error',
        ...agentSessionFailureWords(fact, { agentName: 'Claude', surface: 'row' })
      }
    })
    const startRowKey = agentJournalItemKey(structuredAgentSessionStartFailureRowIdentity('gen'))

    it('reads only the start-failure rows', () => {
      expect(
        structuredAgentSessionStartFailureFacts([
          statusRow(startRowKey, startFailed),
          statusRow(agentJournalSubmissionKey('exit-row'), { kind: 'providerExited' })
        ])
      ).toEqual([startFailed])
    })

    it('says only that each was not sent, and words any other rejection in full', () => {
      const otherRefusal: AgentSessionFailureFact = {
        kind: 'startFailed',
        refusal: { code: 'agent_session_conflict', details: { reason: 'claimConflicted' } }
      }
      const facts = structuredAgentSessionStartFailureFacts([statusRow(startRowKey, startFailed)])
      expect(
        texts(
          [],
          [
            recorded('first', startFailed),
            recorded('second', startFailed),
            recorded('other', otherRefusal)
          ],
          facts
        )
      ).toEqual({
        [agentJournalSubmissionKey('first')]: 'Your message was not sent.',
        [agentJournalSubmissionKey('second')]: 'Your message was not sent.',
        [agentJournalSubmissionKey('other')]:
          "Claude couldn't start. This chat is still open in a terminal agent. Quit that agent to continue the chat here."
      })
    })
  })
})

// Its outcome was lost when the process sending it went away: the row says so for every viewer,
// once nothing running could still deliver it.
describe('a message whose outcome the host lost', () => {
  it.each([
    ['a recovered unknown', row('lost', 'unknown', { recovered: true })],
    [
      "an older host's recovered unknown",
      row('lost', 'unknown', { reason: 'host_restarted_before_acknowledgement' })
    ]
  ])('says it is not confirmed, muted, for %s', (_label, lost) => {
    const notices = structuredAgentSessionDeliveryNotices([], 'Claude', [lost], [])
    expect(notices.get(agentJournalSubmissionKey('lost'))).toEqual({
      muted: true,
      text: NOT_CONFIRMED
    })
  })

  it('says nothing while the agent works or starts, which may still resolve it', () => {
    expect(texts([], [row('lost', 'unknown', { recovered: true })], [], true)).toEqual({})
  })

  it('says nothing for a live unknown, which something running can still answer', () => {
    expect(texts([], [row('live', 'unknown')])).toEqual({})
  })
})
