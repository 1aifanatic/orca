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
  const notices = structuredAgentSessionDeliveryNotices(outbox, blocked, () => {})
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

  // Its Retry would release the stopped queue and send the stopped message too, or wait unseen.
  it('keeps a rejected message its words but not its Retry while the queue is stopped', () => {
    const retry = vi.fn()
    for (const [outbox, blocked] of [
      [[entry('stuck', { state: 'unconfirmed' }), entry('rejected', { state: 'rejected' })], null],
      [[entry('rejected', { state: 'rejected' }), entry('held')], 'held']
    ] as const) {
      const notices = structuredAgentSessionDeliveryNotices([...outbox], blocked, retry)
      expect(notices.get(agentJournalSubmissionKey('rejected'))).toEqual({
        text: 'Message was not sent.'
      })
    }
  })

  it('says nothing on a message that is only waiting its turn or on its way', () => {
    expect(texts([entry('queued'), entry('sending', { state: 'dispatching' })])).toEqual({})
  })
})
