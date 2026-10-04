// What a rejection puts on the user's screen.
//
// The module is pure so this can be asserted directly instead of through the hook,
// which is the whole reason it was split out.

// What a rejection puts on the user's screen.

import { describe, expect, it } from 'vitest'
import type { AgentSessionFailureFact } from './agent-session-failure'
import type { AgentJournalSubmission } from './agent-session-journal-types'
import { DISPATCH_REJECTED_QUEUE_FULL } from './structured-agent-session-dispatch-rejection'
import { agentSessionWriteNoticeEnglish } from './agent-session-refusal-notice'
import { structuredAgentSessionAttemptFailureParts } from './structured-agent-session-send-failure-words'
import { structuredAgentSessionRejectedFailure } from './structured-agent-session-outbox'

function rejected(
  reason: string | null,
  rejection?: AgentSessionFailureFact
): AgentJournalSubmission {
  return {
    clientMessageId: 'client-1',
    fence: 1,
    payloadFingerprint: 'fingerprint',
    dispatchState: 'rejected',
    providerItemId: null,
    reason,
    submittedAt: 10,
    resolvedAt: 10,
    ...(rejection ? { rejection } : {})
  }
}

function notice(reason: string | null, rejection?: AgentSessionFailureFact): string {
  return agentSessionWriteNoticeEnglish(
    structuredAgentSessionAttemptFailureParts(
      structuredAgentSessionRejectedFailure(rejected(reason, rejection))
    )
  )
}

describe('what a rejection shows the user', () => {
  it('never puts the transport marker on screen', () => {
    const shown = notice('provider_write_failed: broken pipe')
    // `provider_write_failed: broken pipe` names nothing a person can act on.
    expect(shown).not.toContain('provider_write_failed')
    expect(shown).not.toContain('broken pipe')
    expect(shown).toBe("Orca couldn't reach the agent. Your message was not sent.")
  })

  it('shows a content rejection in the provider own words', () => {
    // The provider explaining itself IS the answer; a generic string throws it away.
    expect(notice('Claude messages support at most 20 images')).toBe(
      'Claude messages support at most 20 images'
    )
  })

  it('shows the sentence a host wrote for the person reading it', () => {
    const reason = 'The provider stopped before it finished starting.'
    expect(notice(reason)).toBe(reason)
  })

  it('never puts the legacy not_delivered marker on screen', () => {
    // Released clients printed it as it was; it is a marker, not a sentence.
    expect(notice('not_delivered')).toBe('Your message was not sent.')
  })

  it('claims no cause when the rejection names none', () => {
    expect(notice(null)).toBe('Your message was not sent.')
  })

  it('never puts a local-capacity marker on screen either', () => {
    // Neither the provider's words nor a transport failure: a refusal we minted
    // ourselves. It has no user-facing meaning, so it gets copy rather than the token.
    const shown = notice(DISPATCH_REJECTED_QUEUE_FULL)
    expect(shown).not.toContain('queue is full')
    expect(shown).toBe('Your message was not sent.')
  })
})

// A row that carries the host's fact is worded from it; the reason is not read.
describe('what a rejection with a typed fact shows the user', () => {
  it('says Orca could not hand the message over, whatever the reason holds', () => {
    expect(notice('provider_write_failed', { kind: 'writeFailed' })).toBe(
      "Orca couldn't reach the agent. Your message was not sent."
    )
    expect(notice('Something unrelated.', { kind: 'writeFailed' })).toBe(
      "Orca couldn't reach the agent. Your message was not sent."
    )
  })

  it("rebuilds the fact's sentence where a marker stands in for it", () => {
    expect(notice(DISPATCH_REJECTED_QUEUE_FULL, { kind: 'queueFull' })).toBe(
      'Too many messages were waiting for the agent, so this one was not sent.'
    )
  })

  // The surface names the agent; the host's own sentence is never compared or shown.
  it('words the fact itself, never the sentence the host wrote beside it', () => {
    expect(
      notice('Claude never finished starting, so Orca stopped it.', { kind: 'hostStopped' })
    ).toBe('The agent never finished starting, so Orca stopped it.')
  })

  // The message keeps no fact it cannot place, so the host's sentence stands, as on an older host.
  it("shows a newer host's sentence when its fact cannot be placed", () => {
    expect(notice('A sentence a newer host wrote.', JSON.parse('{"kind":"fromTheFuture"}'))).toBe(
      'A sentence a newer host wrote.'
    )
  })

  // The message's copy drops the detail and the refusal these kinds are worded from, so the
  // sentence the host wrote for the person stands in for them; with none, the table's words.
  it("shows the host's sentence for a kind whose words its copy cannot rebuild", () => {
    expect(
      notice('The provider did not accept this message: Image type .bmp.', {
        kind: 'providerRejected',
        detail: { text: 'Image type .bmp', audience: 'person' }
      })
    ).toBe('The provider did not accept this message: Image type .bmp.')
    expect(
      notice("Claude couldn't start. Start a new chat to continue.", {
        kind: 'startFailed',
        refusal: { code: 'agent_session_identity_required' }
      })
    ).toBe("Claude couldn't start. Start a new chat to continue.")
    expect(notice(null, { kind: 'providerRejected' })).toBe(
      'The provider did not accept this message.'
    )
  })

  it('says only that the message was not sent for a fact no message can carry', () => {
    expect(notice('Compaction failed.', { kind: 'compactionFailed' })).toBe(
      'Your message was not sent.'
    )
  })
})
