// When an outbox entry's `delivery` is decided: fixed per operation id once attempted, except that a
// host without the capability never sees the field; decided afresh for an id never attempted.

import { describe, expect, it } from 'vitest'
import {
  createStructuredAgentSessionOutboxEntry,
  type StructuredAgentSessionOutboxEntry
} from './structured-agent-session-outbox'
import { decideStructuredAgentSessionEntryDelivery } from './structured-agent-session-outbox-delivery'

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

const QUEUEING = { capable: true, enabled: true }
const SETTING_OFF = { capable: true, enabled: false }
const OLD_HOST = { capable: false, enabled: false }

describe('outbox entry delivery', () => {
  it('an id never attempted, new or rotated, takes the current choice', () => {
    expect(decideStructuredAgentSessionEntryDelivery(entry(), QUEUEING).delivery).toBe(
      'queue-if-active'
    )
    expect(
      'delivery' in
        decideStructuredAgentSessionEntryDelivery(entry({}, 'queue-if-active'), OLD_HOST)
    ).toBe(false)
    expect(
      'delivery' in
        decideStructuredAgentSessionEntryDelivery(entry({}, 'queue-if-active'), SETTING_OFF)
    ).toBe(false)
  })

  it('an attempted id keeps its fields for fingerprint parity while the host can read them', () => {
    const attempted = entry({ lastAttemptAt: 5 }, 'queue-if-active')
    expect(decideStructuredAgentSessionEntryDelivery(attempted, SETTING_OFF)).toBe(attempted)
    const plain = entry({ lastAttemptAt: 5 })
    expect(decideStructuredAgentSessionEntryDelivery(plain, QUEUEING)).toBe(plain)
  })

  it('no attempt to a host without the capability carries the field, whatever the id', () => {
    const next = decideStructuredAgentSessionEntryDelivery(
      entry({ lastAttemptAt: 5 }, 'queue-if-active'),
      OLD_HOST
    )
    expect('delivery' in next).toBe(false)
    expect(next.clientMessageId).toBe('op-1')
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
    expect('delivery' in decideStructuredAgentSessionEntryDelivery(image, QUEUEING)).toBe(false)
    const launch = entry({ source: 'launch' })
    expect(decideStructuredAgentSessionEntryDelivery(launch, QUEUEING)).toBe(launch)
  })
})
