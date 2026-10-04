// An owner change sends a send left dispatching again under its id. One a Stop outran stays as it
// is: nothing sends it again.

import { describe, expect, it } from 'vitest'
import {
  createStructuredAgentSessionOutboxEntry,
  type StructuredAgentSessionOutboxEntry
} from '../../../../shared/structured-agent-session-outbox'
import { admitStructuredAgentSessionOutboxEntry } from '../../../../shared/structured-agent-session-outbox-admission'
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
  it('resends an interrupted send, but never one a Stop outran', () => {
    const [stopped] = requeueInterruptedStructuredAgentSessionDispatches(
      [dispatching('stopped', { stoppedBy: { operationId: 'stop-1' } })],
      1
    )
    expect(stopped?.state).toBe('dispatching')
    expect(admitStructuredAgentSessionOutboxEntry([stopped!]).state).toBe('idle')
    const [plain] = requeueInterruptedStructuredAgentSessionDispatches([dispatching('plain')], 1)
    expect(admitStructuredAgentSessionOutboxEntry([plain]).state).toBe('dispatch')
  })
})
