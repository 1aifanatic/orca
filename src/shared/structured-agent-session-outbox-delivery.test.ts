// The entry stores the user's intent to queue; each request decides the wire field. An attempted id
// replays its first attempt's fields, waits while the capability is unknown, and drops the field
// only for a host known not to read it.

import { describe, expect, it } from 'vitest'
import {
  createStructuredAgentSessionOutboxEntry,
  type StructuredAgentSessionOutboxEntry
} from './structured-agent-session-outbox'
import {
  structuredAgentSessionEntryDeliveryIntent,
  structuredAgentSessionEntryOnWire
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
      queuedAt: 1,
      ...(delivery ? { delivery } : {})
    }),
    ...overrides
  }
}

const QUEUEING = { capability: 'supported', enabled: true } as const
const SETTING_OFF = { capability: 'supported', enabled: false } as const

describe('outbox delivery intent', () => {
  it('an id never attempted, new or rotated, takes the current choice of a host known to queue', () => {
    expect(structuredAgentSessionEntryDeliveryIntent(entry(), QUEUEING).delivery).toBe(
      'queue-if-active'
    )
    expect(
      'delivery' in
        structuredAgentSessionEntryDeliveryIntent(entry({}, 'queue-if-active'), SETTING_OFF)
    ).toBe(false)
  })

  it('is never decided by an unanswered or negative capability, nor for an attempted id', () => {
    const queued = entry({}, 'queue-if-active')
    for (const capability of ['unknown', 'unsupported'] as const) {
      expect(
        structuredAgentSessionEntryDeliveryIntent(queued, { capability, enabled: false })
      ).toBe(queued)
    }
    const attempted = entry({ lastAttemptAt: 5 }, 'queue-if-active')
    expect(structuredAgentSessionEntryDeliveryIntent(attempted, SETTING_OFF)).toBe(attempted)
  })

  it('an image send and a launch prompt never queue', () => {
    const image = {
      ...entry(),
      body: {
        kind: 'message' as const,
        role: 'user' as const,
        blocks: [{ type: 'image-ref' as const, path: '/tmp/a.png' }]
      }
    }
    expect('delivery' in structuredAgentSessionEntryDeliveryIntent(image, QUEUEING)).toBe(false)
    const launch = entry({ source: 'launch' })
    expect(structuredAgentSessionEntryDeliveryIntent(launch, QUEUEING)).toBe(launch)
  })
})

describe('outbox delivery on the wire', () => {
  const queued = entry({ lastAttemptAt: 5 }, 'queue-if-active')

  it('replays the first attempt unchanged to a host known to queue', () => {
    expect(structuredAgentSessionEntryOnWire(queued, 'supported')).toBe(queued)
  })

  it('holds a queue send while the capability is unknown; a plain send goes', () => {
    expect(structuredAgentSessionEntryOnWire(queued, 'unknown')).toBeNull()
    const plain = entry({ lastAttemptAt: 5 })
    expect(structuredAgentSessionEntryOnWire(plain, 'unknown')).toBe(plain)
  })

  it('drops the field for a host known not to read it, whatever the id', () => {
    const wire = structuredAgentSessionEntryOnWire(queued, 'unsupported')
    expect(wire !== null && 'delivery' in wire).toBe(false)
    expect(wire?.clientMessageId).toBe('op-1')
    expect(queued.delivery).toBe('queue-if-active')
  })
})
