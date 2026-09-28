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

function texts(
  outbox: StructuredAgentSessionOutboxEntry[],
  blocked: string | null = null
): Record<string, string> {
  const notices = structuredAgentSessionDeliveryNotices(outbox, blocked, 'Claude', () => {})
  return Object.fromEntries([...notices].map(([id, notice]) => [id, notice.text]))
}

describe('the notice on each message that did not go through', () => {
  it('gives two failed messages each their own reason and their own Retry', () => {
    const retry = vi.fn()
    const notices = structuredAgentSessionDeliveryNotices(
      [
        entry('first', {
          state: 'rejected',
          lastFailure: { kind: 'rejected', reason: 'Claude messages support at most 20 images' }
        }),
        entry('second', {
          state: 'rejected',
          lastFailure: {
            kind: 'rejected',
            reason: 'Claude never finished starting, so Orca stopped it.',
            rejection: { kind: 'hostStopped' }
          }
        })
      ],
      null,
      'Claude',
      retry
    )

    expect([...notices.keys()]).toEqual([
      agentJournalSubmissionKey('first'),
      agentJournalSubmissionKey('second')
    ])
    expect(notices.get(agentJournalSubmissionKey('first'))?.text).toBe(
      'Claude messages support at most 20 images'
    )
    expect(notices.get(agentJournalSubmissionKey('second'))?.text).toBe(
      'Claude never finished starting, so Orca stopped it.'
    )
    notices.get(agentJournalSubmissionKey('second'))?.onRetry?.()
    expect(retry).toHaveBeenCalledExactlyOnceWith('second')
  })

  it('chooses the words from the saved refusal on the message the queue stopped on', () => {
    expect(
      texts(
        [
          entry('held', {
            lastFailure: { kind: 'refused', code: 'agent_session_owner_restart_failed' }
          })
        ],
        'held'
      )
    ).toEqual({
      [agentJournalSubmissionKey('held')]: "The agent couldn't restart. Your message was not sent."
    })
  })

  // The same rule as a rejected row's: its own Retry is the resend step, and any other step stays.
  it('leaves a retry step to the Retry beside the message the queue stopped on', () => {
    const held = (lastFailure: StructuredAgentSessionOutboxEntry['lastFailure']) =>
      texts([entry('held', { lastFailure })], 'held')
    expect(
      held({
        kind: 'refused',
        code: 'agent_session_journal_unreadable',
        details: { reason: 'journalUnavailable' }
      })
    ).toEqual({
      [agentJournalSubmissionKey('held')]:
        "Orca couldn't open this chat's history right now. Your message was not sent."
    })
    expect(
      held({
        kind: 'refused',
        code: 'agent_session_operation_invalid',
        details: { reason: 'notSignedIn' }
      })
    ).toEqual({
      [agentJournalSubmissionKey('held')]:
        'Your message was not sent. Claude is not signed in for the selected account. Sign in first.'
    })
  })

  it('says a message is unconfirmed, and only that it was not sent when nothing more is known', () => {
    expect(texts([entry('doubt', { state: 'unconfirmed' })])).toEqual({
      [agentJournalSubmissionKey('doubt')]: 'Message delivery is unconfirmed.'
    })
    expect(texts([entry('bare')], 'bare')).toEqual({
      [agentJournalSubmissionKey('bare')]: 'Message was not sent.'
    })
  })

  // The drain's own rule: a message behind the one the queue stopped on is only waiting, so it says
  // nothing. A rejected message holds nothing up and keeps its words.
  it('says why on the message the queue stopped on and on every rejected one', () => {
    expect(
      texts([
        entry('sent', { state: 'dispatching' }),
        entry('rejected', { state: 'rejected' }),
        entry('stuck', { state: 'unconfirmed' }),
        entry('behind', { state: 'unconfirmed' }),
        entry('queued')
      ])
    ).toEqual({
      [agentJournalSubmissionKey('rejected')]: 'Message was not sent.',
      [agentJournalSubmissionKey('stuck')]: 'Message delivery is unconfirmed.'
    })
  })

  // Its Retry would put it back in the queue to wait unseen behind the stopped message.
  it('keeps a rejected message its words but not its Retry while the queue is stopped', () => {
    const retry = vi.fn()
    for (const [outbox, blocked] of [
      [[entry('stuck', { state: 'unconfirmed' }), entry('rejected', { state: 'rejected' })], null],
      [[entry('rejected', { state: 'rejected' }), entry('held')], 'held']
    ] as const) {
      const notices = structuredAgentSessionDeliveryNotices([...outbox], blocked, 'Claude', retry)
      expect(notices.get(agentJournalSubmissionKey('rejected'))).toEqual({
        text: 'Message was not sent.'
      })
    }
  })

  // Beside its own Retry the resend step is the button; without one the words keep it.
  it('leaves out sending again only where the message has its own Retry', () => {
    const startFailed = (clientMessageId: string): StructuredAgentSessionOutboxEntry =>
      entry(clientMessageId, {
        state: 'rejected',
        lastFailure: {
          kind: 'rejected',
          reason: 'Claude stopped before it finished starting. Send your message to try again.',
          rejection: { kind: 'providerStartFailed' }
        }
      })
    expect(texts([startFailed('first'), startFailed('second')])).toEqual({
      [agentJournalSubmissionKey('first')]: 'Claude stopped before it finished starting.',
      [agentJournalSubmissionKey('second')]: 'Claude stopped before it finished starting.'
    })
    expect(texts([startFailed('rejected'), entry('held')], 'held')).toMatchObject({
      [agentJournalSubmissionKey('rejected')]:
        'Claude stopped before it finished starting. Send your message to try again.'
    })
  })

  it.each([
    [
      'notDelivered',
      'This message was not delivered. Send it again to continue.',
      'This message was not delivered.'
    ],
    [
      'hostFault',
      "Orca ran into a problem, so this didn't go through. Try again.",
      "Orca ran into a problem, so this didn't go through."
    ]
  ] as const)('leaves the step to the Retry beside a %s message', (kind, reason, shown) => {
    expect(
      texts([
        entry('rejected', {
          state: 'rejected',
          lastFailure: { kind: 'rejected', reason, rejection: { kind } }
        })
      ])
    ).toEqual({ [agentJournalSubmissionKey('rejected')]: shown })
  })

  // The stored fact keeps less than the host wrote from, so it rewords only a reason it rebuilds.
  it('keeps a reason its stored fact cannot rebuild, beside its Retry too', () => {
    const rejected = (reason: string): StructuredAgentSessionOutboxEntry =>
      entry('rejected', {
        state: 'rejected',
        lastFailure: { kind: 'rejected', reason, rejection: { kind: 'startFailed' } }
      })
    for (const reason of [
      "Claude couldn't start. Start a new chat to continue.",
      "Claude couldn't start. This chat is still open in a terminal agent. Quit that agent to continue the chat here."
    ]) {
      expect(texts([rejected(reason)])).toEqual({ [agentJournalSubmissionKey('rejected')]: reason })
    }
    expect(texts([rejected("Claude couldn't start. Send your message to try again.")])).toEqual({
      [agentJournalSubmissionKey('rejected')]: "Claude couldn't start."
    })
  })

  it('says nothing on a message that is only waiting its turn or on its way', () => {
    expect(texts([entry('queued'), entry('sending', { state: 'dispatching' })])).toEqual({})
  })
})
