// When the user acted for the send that begins their next turn: the time they wrote it, or queued
// the draft it was handed over from.

import { describe, expect, it, vi } from 'vitest'
import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import { newestAcceptedSend } from './structured-agent-session-status-child-work'

function submission(
  clientMessageId: string,
  submittedAt: number,
  overrides: Partial<AgentJournalSubmission> = {}
): AgentJournalSubmission {
  return {
    clientMessageId,
    fence: 1,
    payloadFingerprint: clientMessageId,
    dispatchState: 'accepted',
    providerItemId: null,
    reason: null,
    submittedAt,
    resolvedAt: submittedAt,
    ...overrides
  }
}

describe('newestAcceptedSend', () => {
  it('dates a direct send by when it was written', () => {
    const queuedAt = vi.fn(() => undefined)
    expect(
      newestAcceptedSend(
        'epoch-1',
        [submission('first', 10), submission('pending', 30, { dispatchState: 'pending' })],
        queuedAt
      )
    ).toEqual({ epoch: 'epoch-1', clientMessageId: 'first', actedAt: 10 })
    expect(queuedAt).not.toHaveBeenCalled()
  })

  it('dates a send handed over from a queued draft by when the draft was queued', () => {
    const queuedAt = vi.fn(() => 5)
    const handedOver = [submission('handed-over', 40, { queuedMessageId: 'draft-1' })]
    const read = newestAcceptedSend('epoch-1', handedOver, queuedAt)
    expect(read).toEqual({ epoch: 'epoch-1', clientMessageId: 'handed-over', actedAt: 5 })
    expect(queuedAt).toHaveBeenCalledWith('draft-1')
    // Still the newest: the draft table is not read again.
    expect(newestAcceptedSend('epoch-1', handedOver, queuedAt, read)).toBe(read)
    expect(queuedAt).toHaveBeenCalledTimes(1)
  })

  it('names no send, and no time, in a conversation with none accepted', () => {
    expect(newestAcceptedSend('epoch-2', [], () => undefined)).toEqual({
      epoch: 'epoch-2',
      clientMessageId: null
    })
  })
})
