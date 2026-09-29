// The entry keeps the user's intent and what its first attempt sent; each request decides the wire
// field from those and the host's capability. Nothing ever waits on the capability.

import { describe, expect, it } from 'vitest'
import {
  createStructuredAgentSessionOutboxEntry,
  type StructuredAgentSessionOutboxEntry
} from './structured-agent-session-outbox'
import {
  structuredAgentSessionEntryAttempt,
  structuredAgentSessionEntryDeliveryIntent,
  type StructuredAgentSessionQueueCapability
} from './structured-agent-session-outbox-delivery'

function entry(
  overrides: Partial<StructuredAgentSessionOutboxEntry> = {},
  delivery?: 'queue-if-active'
): StructuredAgentSessionOutboxEntry {
  return {
    ...createStructuredAgentSessionOutboxEntry({
      clientMessageId: 'op-1',
      sessionId: 'session-1',
      text: 'hello',
      attachments: [],
      queuedAt: 1
    }),
    ...(delivery ? { delivery } : {}),
    ...overrides
  }
}

function host(capability: StructuredAgentSessionQueueCapability, enabled = true) {
  return { capability, enabled }
}

describe('the intent at enqueue', () => {
  it('asks to queue only of a host known to queue, with the setting on, for plain text', () => {
    expect(structuredAgentSessionEntryDeliveryIntent(entry(), host('supported')).delivery).toBe(
      'queue-if-active'
    )
    for (const off of [host('unknown'), host('unsupported'), host('supported', false)]) {
      expect('delivery' in structuredAgentSessionEntryDeliveryIntent(entry(), off)).toBe(false)
    }
    const image = {
      ...entry(),
      body: {
        kind: 'message' as const,
        role: 'user' as const,
        blocks: [{ type: 'image-ref' as const, path: '/tmp/a.png' }]
      }
    }
    expect('delivery' in structuredAgentSessionEntryDeliveryIntent(image, host('supported'))).toBe(
      false
    )
    const launch = entry({ source: 'launch' })
    expect(structuredAgentSessionEntryDeliveryIntent(launch, host('supported'))).toBe(launch)
  })
})

describe('a first attempt', () => {
  it('records what it sent, and sends plain and immediate while the capability is unknown', () => {
    const queued = structuredAgentSessionEntryAttempt(
      entry({}, 'queue-if-active'),
      host('supported')
    )
    expect(queued.wire.delivery).toBe('queue-if-active')
    expect(queued.stored.sentDelivery).toBe('queue-if-active')

    const unknown = structuredAgentSessionEntryAttempt(
      entry({}, 'queue-if-active'),
      host('unknown')
    )
    expect('delivery' in unknown.wire).toBe(false)
    expect(unknown.stored.sentDelivery).toBeNull()
    // The capability never rewrites the intent.
    expect(unknown.stored.delivery).toBe('queue-if-active')
  })

  it('with the setting off drops the intent too, whatever the capability', () => {
    for (const capability of ['supported', 'unknown', 'unsupported'] as const) {
      const attempt = structuredAgentSessionEntryAttempt(
        entry({}, 'queue-if-active'),
        host(capability, false)
      )
      expect('delivery' in attempt.wire).toBe(false)
      expect('delivery' in attempt.stored).toBe(false)
      expect(attempt.stored.sentDelivery).toBeNull()
    }
  })
})

describe('a replay of an attempted id', () => {
  const sentQueued = entry({ lastAttemptAt: 5, sentDelivery: 'queue-if-active' }, 'queue-if-active')
  const sentPlain = entry({ lastAttemptAt: 5, sentDelivery: null }, 'queue-if-active')

  it('sends exactly what it first sent, while the capability is unknown or the setting off', () => {
    for (const current of [host('unknown'), host('supported', false), host('supported')]) {
      expect(structuredAgentSessionEntryAttempt(sentQueued, current).wire.delivery).toBe(
        'queue-if-active'
      )
      expect('delivery' in structuredAgentSessionEntryAttempt(sentPlain, current).wire).toBe(false)
      expect(structuredAgentSessionEntryAttempt(sentQueued, current).stored).toBe(sentQueued)
    }
  })

  it('drops the field for a host known not to read it, and keeps what was sent', () => {
    const attempt = structuredAgentSessionEntryAttempt(sentQueued, host('unsupported'))
    expect('delivery' in attempt.wire).toBe(false)
    expect(attempt.wire.clientMessageId).toBe('op-1')
    expect(attempt.stored).toBe(sentQueued)
  })

  it('an entry attempted before the field was recorded replays its intent', () => {
    const legacy = entry({ lastAttemptAt: 5 }, 'queue-if-active')
    expect(structuredAgentSessionEntryAttempt(legacy, host('unknown')).wire.delivery).toBe(
      'queue-if-active'
    )
  })
})
