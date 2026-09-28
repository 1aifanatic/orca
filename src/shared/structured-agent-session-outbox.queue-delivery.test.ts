// `delivery: 'queue-if-active'` on an outbox entry: stamped once at enqueue,
// persisted, replayed identically, and absent — key and all — from any send an
// incapable host could see (its strict schema refuses unknown keys).

import { describe, expect, it } from 'vitest'
import { structuredAgentSessionPayloadFingerprint } from './structured-agent-session-mutation'
import {
  createStructuredAgentSessionOutboxEntry,
  parseStructuredAgentSessionOutboxEntry,
  structuredAgentSessionSendMutation,
  structuredAgentSessionSendRequest,
  type StructuredAgentSessionOutboxState
} from './structured-agent-session-outbox'
import { withdrawUnsentStructuredAgentSessionOutboxEntries } from './structured-agent-session-outbox-stop'

function entry(delivery?: 'queue-if-active') {
  return createStructuredAgentSessionOutboxEntry({
    clientMessageId: 'client-1',
    sessionId: 'session-1',
    text: 'hello',
    attachments: [],
    queuedAt: 1,
    ...(delivery ? { delivery } : {})
  })
}

describe('outbox queue delivery', () => {
  it('sends `delivery` and digests it into the operation fingerprint, exactly as the host does', () => {
    const mutation = structuredAgentSessionSendMutation(entry('queue-if-active'), 3)
    expect(mutation.delivery).toBe('queue-if-active')
    expect(mutation.envelope.payloadFingerprint).toBe(
      structuredAgentSessionPayloadFingerprint({
        method: 'agentSession.send',
        sessionId: 'session-1',
        fields: { body: mutation.body, delivery: 'queue-if-active' }
      })
    )
  })

  it('a plain entry keeps exactly the request an older host has always seen', () => {
    const request = structuredAgentSessionSendRequest(entry(), 3)
    expect('delivery' in request).toBe(false)
    const mutation = structuredAgentSessionSendMutation(entry(), 3)
    expect(mutation.envelope.payloadFingerprint).toBe(
      structuredAgentSessionPayloadFingerprint({
        method: 'agentSession.send',
        sessionId: 'session-1',
        fields: { body: mutation.body }
      })
    )
  })

  it('persists through a storage round-trip so a retry replays the same operation', () => {
    const parsed = parseStructuredAgentSessionOutboxEntry(
      JSON.parse(JSON.stringify(entry('queue-if-active'))),
      'session-1'
    )
    expect(parsed?.delivery).toBe('queue-if-active')
    const plain = parseStructuredAgentSessionOutboxEntry(
      JSON.parse(JSON.stringify(entry())),
      'session-1'
    )
    expect(plain !== null && 'delivery' in plain).toBe(false)
    const foreign = parseStructuredAgentSessionOutboxEntry(
      { ...JSON.parse(JSON.stringify(entry())), delivery: 'something-newer' },
      'session-1'
    )
    expect(foreign !== null && 'delivery' in foreign).toBe(false)
  })

  it('Stop withdraws a queue send that never left, but never one whose answer is still out', () => {
    // An issued queue send may already be a host-held draft: withdrawing it locally too
    // would put the same text in the composer AND on a card. Its answer settles it.
    const at = (
      id: string,
      state: StructuredAgentSessionOutboxState,
      delivery?: 'queue-if-active'
    ) => ({
      ...createStructuredAgentSessionOutboxEntry({
        clientMessageId: id,
        sessionId: 'session-1',
        text: `text of ${id}`,
        attachments: [],
        queuedAt: 1,
        ...(delivery ? { delivery } : {})
      }),
      state
    })
    const next = withdrawUnsentStructuredAgentSessionOutboxEntries(
      [
        at('never-left', 'queued', 'queue-if-active'),
        at('in-flight', 'dispatching', 'queue-if-active'),
        at('in-doubt', 'unconfirmed', 'queue-if-active'),
        at('plain-in-flight', 'dispatching')
      ],
      [],
      null
    )
    expect(next.map((entry) => entry.clientMessageId)).toEqual(['in-flight', 'in-doubt'])
  })
})
