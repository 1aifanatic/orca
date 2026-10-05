// `delivery: 'queue-if-active'` on a send: recorded as the entry's `sentDelivery` by its first
// attempt, persisted, replayed identically, and absent — key and all — from any send an incapable
// host could see (its strict schema refuses unknown keys).

import { describe, expect, it } from 'vitest'
import { structuredAgentSessionPayloadFingerprint } from './structured-agent-session-mutation'
import {
  createStructuredAgentSessionOutboxEntry,
  stageStructuredAgentSessionOutboxEntryForSend,
  structuredAgentSessionSendMutation,
  structuredAgentSessionSendRequest,
  type StructuredAgentSessionOutboxState
} from './structured-agent-session-outbox'
import { parseStructuredAgentSessionOutboxEntry } from './structured-agent-session-outbox-saved-entry'
import { admitStructuredAgentSessionOutboxEntry } from './structured-agent-session-outbox-admission'
import { structuredAgentSessionEntryAttempt } from './structured-agent-session-outbox-delivery'
import {
  applyStructuredAgentSessionOutboxSettlement,
  settleStructuredAgentSessionSendAnswer
} from './structured-agent-session-outbox-settlement'
import { stopStructuredAgentSessionOutbox } from './structured-agent-session-outbox-stop-withdrawal'

function entry(sentDelivery?: 'queue-if-active') {
  return {
    ...createStructuredAgentSessionOutboxEntry({
      clientMessageId: 'client-1',
      sessionId: 'session-1',
      text: 'hello',
      attachments: [],
      queuedAt: 1
    }),
    ...(sentDelivery ? { sentDelivery } : {})
  }
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
    expect(parsed?.sentDelivery).toBe('queue-if-active')
    const plain = parseStructuredAgentSessionOutboxEntry(
      JSON.parse(JSON.stringify(entry())),
      'session-1'
    )
    expect(plain !== null && 'sentDelivery' in plain).toBe(false)
    const foreign = parseStructuredAgentSessionOutboxEntry(
      { ...JSON.parse(JSON.stringify(entry())), sentDelivery: 'something-newer' },
      'session-1'
    )
    expect(foreign !== null && 'sentDelivery' in foreign).toBe(false)
  })

  it('Stop stamps every send that has gone out, in any state, and never admits it again', () => {
    // An attempted queue send may already be a host-held draft: withdrawing it locally too would
    // put the same text in the composer AND on a card. Read from what went on the wire.
    const at = (
      id: string,
      state: StructuredAgentSessionOutboxState,
      sent?: 'queue-if-active' | null
    ) => ({
      ...createStructuredAgentSessionOutboxEntry({
        clientMessageId: id,
        sessionId: 'session-1',
        text: `text of ${id}`,
        attachments: [],
        queuedAt: 1
      }),
      ...(sent !== undefined ? { lastAttemptAt: 2, sentDelivery: sent } : {}),
      state
    })
    const next = stopStructuredAgentSessionOutbox(
      [
        at('never-left', 'queued'),
        // No in-flight id: a `pending` answer freed single-flight before its journal row landed.
        at('in-flight', 'dispatching', 'queue-if-active'),
        at('in-doubt', 'unconfirmed', 'queue-if-active'),
        // Probed back to queued after a lost answer: still out there, not unsent.
        at('probed', 'queued', 'queue-if-active'),
        at('sent-plain', 'dispatching', null)
      ],
      [],
      null,
      'stop-1'
    )
    expect(next.withdrawn.map((entry) => entry.clientMessageId)).toEqual(['never-left'])
    // Its state is left to its answer: only the stamp holds it back.
    expect(
      next.entries.map((entry) => [
        entry.clientMessageId,
        entry.state,
        entry.stoppedBy?.operationId
      ])
    ).toEqual([
      ['in-flight', 'dispatching', 'stop-1'],
      ['in-doubt', 'unconfirmed', 'stop-1'],
      ['probed', 'queued', 'stop-1'],
      ['sent-plain', 'dispatching', 'stop-1']
    ])
    expect(admitStructuredAgentSessionOutboxEntry(next.entries)).toEqual({
      state: 'idle',
      entry: null
    })
  })

  it('Stop during a first queue attempt, then a refusal: its own answer returns it, as without it', () => {
    const attempt = structuredAgentSessionEntryAttempt(entry(), {
      capability: 'supported',
      enabled: true
    })
    const staged = stageStructuredAgentSessionOutboxEntryForSend(attempt.stored, 10)
    const settlement = settleStructuredAgentSessionSendAnswer(
      {
        kind: 'result',
        result: {
          ok: false,
          refusal: {
            code: 'agent_session_operation_invalid',
            message: 'The message queue is full.'
          }
        }
      },
      'client-1',
      {
        firstAttempt: true,
        answersProve: false,
        journalHasRow: false,
        rowLoaded: true,
        outlivedHostWindow: false
      }
    )
    const stopped = stopStructuredAgentSessionOutbox([staged], [], 'client-1', 'stop-1').entries
    for (const entries of [stopped, [staged]]) {
      const settled = applyStructuredAgentSessionOutboxSettlement(entries, 'client-1', settlement)
      expect(settled.entries).toMatchObject([
        { clientMessageId: 'client-1', returning: { ending: 'returned' } }
      ])
      expect(settled.returned?.entry.clientMessageId).toBe('client-1')
    }
  })
})
