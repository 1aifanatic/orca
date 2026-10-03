import { describe, expect, it } from 'vitest'
import type { AgentJournalSubmission } from './agent-session-journal-types'
import {
  isRecoveredStructuredAgentSessionSubmission,
  isUnansweredStructuredAgentSessionDispatch
} from './structured-agent-session-unanswered-dispatch'

function submission(patch: Partial<AgentJournalSubmission>): AgentJournalSubmission {
  return {
    clientMessageId: 'client-1',
    fence: 1,
    payloadFingerprint: 'fingerprint',
    dispatchState: 'unknown',
    providerItemId: null,
    reason: null,
    submittedAt: 1,
    resolvedAt: 1,
    ...patch
  }
}

describe('a send whose outcome the host lost for good', () => {
  it('is one the host marked recovered', () => {
    const row = submission({ recovered: true, reason: 'provider_exited_before_acknowledgement' })
    expect(isRecoveredStructuredAgentSessionSubmission(row)).toBe(true)
    expect(isUnansweredStructuredAgentSessionDispatch(row)).toBe(false)
  })

  it("is an older host's restart row, which carries the reason without the marker", () => {
    const row = submission({ reason: 'host_restarted_before_acknowledgement' })
    expect(isRecoveredStructuredAgentSessionSubmission(row)).toBe(true)
    expect(isUnansweredStructuredAgentSessionDispatch(row)).toBe(false)
  })

  it('is never a live unknown, which something still running may answer', () => {
    const row = submission({ reason: 'provider_ack_ambiguous' })
    expect(isRecoveredStructuredAgentSessionSubmission(row)).toBe(false)
    expect(isUnansweredStructuredAgentSessionDispatch(row)).toBe(true)
  })

  it('is never a settled send, whatever its reason says', () => {
    expect(
      isRecoveredStructuredAgentSessionSubmission(
        submission({ dispatchState: 'rejected', reason: 'host_restarted_before_acknowledgement' })
      )
    ).toBe(false)
  })
})
