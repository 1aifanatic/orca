import { describe, expect, it } from 'vitest'
import type { AgentSessionFailureFact } from './agent-session-failure'
import { agentSessionFailureWords } from './agent-session-failure-words'
import { agentJournalItemKey } from './agent-session-journal-item-key'
import type { AgentJournalRenderItem, AgentJournalSubmission } from './agent-session-journal-types'
import { agentSessionWriteNoticeEnglish } from './agent-session-refusal-notice'
import { structuredAgentSessionRecordedRejectionParts } from './structured-agent-session-rejection-words'
import { structuredAgentSessionStartFailureFacts } from './structured-agent-session-start-failure-facts'
import { structuredAgentSessionStartFailureRowIdentity } from './structured-agent-session-start-failure-row-key'

function rejected(patch: Partial<AgentJournalSubmission> = {}): AgentJournalSubmission {
  return {
    clientMessageId: 'sent',
    fence: 1,
    payloadFingerprint: 'fingerprint',
    dispatchState: 'rejected',
    providerItemId: null,
    reason: 'provider_write_failed: broken pipe',
    submittedAt: 1,
    resolvedAt: 1,
    ...patch
  }
}

function startRow(fact: AgentSessionFailureFact): AgentJournalRenderItem {
  return {
    itemId: agentJournalItemKey(structuredAgentSessionStartFailureRowIdentity('gen')),
    revision: 1,
    sequence: 1,
    observedAt: 1,
    body: {
      kind: 'status',
      tone: 'error',
      ...agentSessionFailureWords(fact, { agentName: 'Claude', surface: 'row' })
    }
  }
}

function line(
  submission: AgentJournalSubmission,
  items: readonly AgentJournalRenderItem[] = []
): string {
  return agentSessionWriteNoticeEnglish(
    structuredAgentSessionRecordedRejectionParts(
      submission,
      { agentName: 'Claude' },
      structuredAgentSessionStartFailureFacts(items)
    )
  )
}

describe('the line under a message the host recorded and then rejected', () => {
  it("says why, in the host's words", () => {
    expect(line(rejected())).toBe("Orca couldn't reach the agent. Your message was not sent.")
    expect(line(rejected({ reason: 'Claude does not support .bmp' }))).toBe(
      'Claude does not support .bmp'
    )
  })

  it("words the host's typed fact when no loaded row states it", () => {
    const startFailed: AgentSessionFailureFact = { kind: 'startFailed' }
    expect(line(rejected({ reason: 'Written by the host.', rejection: startFailed }))).toBe(
      "Claude couldn't start. Send your message to try again."
    )
  })

  it('says only that it was not sent when a loaded start-failure row already says why', () => {
    const startFailed: AgentSessionFailureFact = { kind: 'startFailed' }
    expect(
      line(rejected({ reason: 'Written by the host.', rejection: startFailed }), [
        startRow(startFailed)
      ])
    ).toBe('Your message was not sent.')
  })

  it('keeps its own words when the loaded start row states a different failure', () => {
    const conflict: AgentSessionFailureFact = {
      kind: 'startFailed',
      refusal: { code: 'agent_session_conflict', details: { reason: 'claimConflicted' } }
    }
    expect(
      line(rejected({ reason: 'Written by the host.', rejection: conflict }), [
        startRow({ kind: 'startFailed' })
      ])
    ).toBe(
      "Claude couldn't start. This chat is still open in a terminal agent. Quit that agent to continue the chat here."
    )
  })
})
