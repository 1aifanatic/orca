import { describe, expect, it } from 'vitest'
import { AGENT_SESSION_FAILURE_KINDS, agentSessionFailureFact } from './agent-session-failure'
import { agentSessionFailureWords } from './agent-session-failure-words'
import {
  classifyDispatchRejection,
  DISPATCH_REJECTED_CANCELLED,
  DISPATCH_REJECTED_CODEX_QUEUE_FULL,
  DISPATCH_REJECTED_HOST_RESTARTED,
  DISPATCH_REJECTED_PROVIDER_CLOSED,
  DISPATCH_REJECTED_QUEUE_FULL,
  isWriteFailureSubmission
} from './structured-agent-session-dispatch-rejection'

describe('classifyDispatchRejection', () => {
  it.each([
    [DISPATCH_REJECTED_CANCELLED, 'withdrawn', null, 'cancelled'],
    [DISPATCH_REJECTED_HOST_RESTARTED, 'undelivered', null, 'hostRestarted'],
    [DISPATCH_REJECTED_PROVIDER_CLOSED, 'undelivered', null, 'chatClosed'],
    ['not_delivered', 'undelivered', 'failure', 'notDelivered'],
    [DISPATCH_REJECTED_QUEUE_FULL, 'transport', 'failure', 'queueFull'],
    [DISPATCH_REJECTED_CODEX_QUEUE_FULL, 'transport', 'failure', 'queueFull'],
    ['provider_write_failed: broken pipe', 'transport', 'failure', 'writeFailed'],
    ['provider_write_failed', 'transport', 'failure', 'writeFailed']
  ] as const)('reads the legacy marker %j', (reason, category, verdict, kind) => {
    expect(classifyDispatchRejection({ reason })).toEqual({ category, verdict, kind })
  })

  it('reads any other legacy reason as a sentence that failed the send', () => {
    expect(classifyDispatchRejection({ reason: 'Claude does not support .bmp' })).toEqual({
      category: 'content',
      verdict: 'failure'
    })
    expect(classifyDispatchRejection({ reason: null })).toEqual({
      category: 'content',
      verdict: 'failure'
    })
  })

  it('fails the send for every kind but a withdrawal, a host restart, or a closed chat', () => {
    for (const kind of AGENT_SESSION_FAILURE_KINDS) {
      const verdict = classifyDispatchRejection({ reason: 'x', rejection: { kind } }).verdict
      expect([kind, verdict]).toEqual([
        kind,
        kind === 'cancelled' || kind === 'hostRestarted' || kind === 'chatClosed' ? null : 'failure'
      ])
    }
  })

  it('reads the typed fact over the sentence beside it', () => {
    expect(
      classifyDispatchRejection({
        reason: 'The provider stopped before it finished starting.',
        rejection: { kind: 'providerStartFailed' }
      })
    ).toEqual({ category: 'startFailed', verdict: 'failure', kind: 'providerStartFailed' })
    expect(
      classifyDispatchRejection({ reason: 'Not sent.', rejection: { kind: 'queueFull' } })
    ).toMatchObject({ category: 'transport', verdict: 'failure' })
  })

  it('writes a sentence, not a marker released clients would print, for a restart or a close', () => {
    for (const kind of ['hostRestarted', 'chatClosed'] as const) {
      const written = agentSessionFailureWords(agentSessionFailureFact(kind), {
        surface: 'rejection'
      })
      expect(written.reason).not.toMatch(/^[a-z_]+$/)
      expect(classifyDispatchRejection(written)).toEqual({
        category: 'undelivered',
        verdict: null,
        kind
      })
    }
  })

  it('falls back to the reason when a newer host wrote a kind this build does not know', () => {
    const rejection = JSON.parse('{"kind":"futureKind"}')
    expect(
      classifyDispatchRejection({ reason: DISPATCH_REJECTED_CANCELLED, rejection })
    ).toMatchObject({ category: 'withdrawn', verdict: null })
  })
})

describe('isWriteFailureSubmission', () => {
  it('holds for a legacy row in any state that carries the marker', () => {
    expect(
      isWriteFailureSubmission({ reason: 'provider_write_failed: closed before enqueue' })
    ).toBe(true)
  })

  it('holds for the bare marker a new host writes, as released clients already read it', () => {
    const written = agentSessionFailureWords(agentSessionFailureFact('writeFailed'), {
      surface: 'rejection'
    })
    expect(written.reason).toBe('provider_write_failed')
    expect(isWriteFailureSubmission({ reason: written.reason })).toBe(true)
  })

  it('holds for a typed write failure and for nothing else', () => {
    expect(isWriteFailureSubmission({ reason: 'x', rejection: { kind: 'writeFailed' } })).toBe(true)
    expect(isWriteFailureSubmission({ reason: DISPATCH_REJECTED_QUEUE_FULL })).toBe(false)
    expect(isWriteFailureSubmission({ reason: 'x', rejection: { kind: 'queueFull' } })).toBe(false)
    expect(isWriteFailureSubmission({ reason: null })).toBe(false)
  })
})
