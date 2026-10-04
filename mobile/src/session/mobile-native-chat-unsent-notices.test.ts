import { describe, expect, it } from 'vitest'
import type { AgentSessionFailureFact } from '../../../src/shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../src/shared/agent-session-failure-words'
import {
  agentJournalItemKey,
  agentJournalSubmissionKey
} from '../../../src/shared/agent-session-journal-item-key'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../src/shared/agent-session-journal-types'
import { structuredAgentSessionCommandResultRowIdentity } from '../../../src/shared/structured-agent-session-command-entry'
import { structuredAgentSessionStartFailureRowIdentity } from '../../../src/shared/structured-agent-session-start-failure-row-key'
import { mobileNativeChatUnsentNotices } from './mobile-native-chat-unsent-notices'

function rejected(patch: Partial<AgentJournalSubmission> = {}): AgentJournalSubmission {
  return {
    clientMessageId: 'sent-elsewhere',
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

describe('the line under a message the host recorded and did not deliver', () => {
  it("says why, in the host's words, keyed by the message's row", () => {
    const notices = mobileNativeChatUnsentNotices(
      { items: [], submissions: [rejected()] },
      'claude'
    )
    expect(notices.get(agentJournalSubmissionKey('sent-elsewhere'))).toBe(
      "Orca couldn't reach the agent. Your message was not sent."
    )
  })

  it('says only that it was not sent when the start-failure row already says why', () => {
    const startFailed: AgentSessionFailureFact = { kind: 'startFailed' }
    const startRow: AgentJournalRenderItem = {
      itemId: agentJournalItemKey(structuredAgentSessionStartFailureRowIdentity('gen')),
      revision: 1,
      sequence: 1,
      observedAt: 1,
      body: {
        kind: 'status',
        tone: 'error',
        ...agentSessionFailureWords(startFailed, { agentName: 'Claude', surface: 'row' })
      }
    }
    const notices = mobileNativeChatUnsentNotices(
      {
        items: [startRow],
        submissions: [rejected({ reason: 'Written by the host.', rejection: startFailed })]
      },
      'claude'
    )
    expect(notices.get(agentJournalSubmissionKey('sent-elsewhere'))).toBe(
      'Your message was not sent.'
    )
  })

  // Its turn's result row says how a refused command ended; a blocked one has only its own line.
  it("says only that a command was not sent when its result row says why, else the command's words", () => {
    const providerRejected: AgentSessionFailureFact = {
      kind: 'providerRejected',
      detail: { text: 'busy', audience: 'person' }
    }
    const refused = rejected({ clientMessageId: 'compact-1', rejection: providerRejected })
    const resultRow: AgentJournalRenderItem = {
      itemId: agentJournalItemKey(structuredAgentSessionCommandResultRowIdentity('compact-1')),
      revision: 1,
      sequence: 2,
      observedAt: 2,
      body: {
        kind: 'status',
        tone: 'error',
        ...agentSessionFailureWords(
          { kind: 'compactionFailed', detail: { text: 'busy', audience: 'person' } },
          { agentName: 'Codex', surface: 'row' }
        )
      }
    }
    const blocked = rejected({
      clientMessageId: 'compact-2',
      rejection: { kind: 'commandRefused' }
    })
    const notices = mobileNativeChatUnsentNotices(
      { items: [resultRow], submissions: [refused, blocked] },
      'codex'
    )
    expect(notices.get(agentJournalSubmissionKey('compact-1'))).toBe('Your message was not sent.')
    expect(notices.get(agentJournalSubmissionKey('compact-2'))).toBe(
      "This command didn't run. Try it again."
    )
  })

  it('has nothing to say when no send was rejected', () => {
    expect(
      mobileNativeChatUnsentNotices(
        { items: [], submissions: [rejected({ dispatchState: 'accepted' })] },
        'claude'
      ).size
    ).toBe(0)
    expect(mobileNativeChatUnsentNotices(null, 'claude').size).toBe(0)
  })
})
