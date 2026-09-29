// An owner change sends a send left dispatching again under its id, except one a Stop outlived:
// only the user's Retry sends that one again.

import { describe, expect, it } from 'vitest'
import {
  createStructuredAgentSessionOutboxEntry,
  type StructuredAgentSessionOutboxEntry
} from '../../../../shared/structured-agent-session-outbox'
import { requeueInterruptedStructuredAgentSessionDispatches } from './structured-agent-session-outbox-dispatch'

function dispatching(
  clientMessageId: string,
  overrides: Partial<StructuredAgentSessionOutboxEntry> = {}
): StructuredAgentSessionOutboxEntry {
  return {
    ...createStructuredAgentSessionOutboxEntry({
      clientMessageId,
      sessionId: 'session-1',
      text: clientMessageId,
      attachments: [],
      queuedAt: 1
    }),
    state: 'dispatching',
    lastAttemptAt: 2,
    ...overrides
  }
}

describe('requeue after an owner change', () => {
  it('resends an interrupted send, but parks one a Stop outlived for Retry', () => {
    const next = requeueInterruptedStructuredAgentSessionDispatches(
      [dispatching('plain'), dispatching('stopped', { outlivedStop: true })],
      1
    )
    expect(next.map((entry) => [entry.clientMessageId, entry.state])).toEqual([
      ['plain', 'queued'],
      ['stopped', 'unconfirmed']
    ])
  })
})
