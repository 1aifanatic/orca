import { describe, expect, it } from 'vitest'
import { agentJournalSubmissionKey } from './agent-session-journal-item-key'
import type { AgentJournalRenderItem, AgentJournalSubmission } from './agent-session-journal-types'
import { AgentJournalSubmissionSchema } from './agent-session-journal-schemas'
import { latestStructuredAgentSessionRequest } from './structured-agent-session-latest-request'
import { isStructuredAgentSessionMainAgentWorking } from './structured-agent-session-main-agent-working'
import {
  isRetryingStructuredAgentSessionStart,
  structuredAgentSessionStartRetryAt
} from './structured-agent-session-start-retry'

const FAILED_AT = 1_000

describe('when a message whose agent start failed is tried again', () => {
  it('waits 15 s, 1 min and 5 min after a start refused before it ran, then is done trying', () => {
    const beforeHandoff = { kind: 'accountSwitchInProgress' } as const
    expect(
      [1, 2, 3, 4].map((attempts) =>
        structuredAgentSessionStartRetryAt(beforeHandoff, attempts, FAILED_AT)
      )
    ).toEqual([FAILED_AT + 15_000, FAILED_AT + 60_000, FAILED_AT + 300_000, null])
  })

  it.each([
    ['an account switch in progress', { kind: 'accountSwitchInProgress' }],
    [
      'an owner still being reconciled',
      { kind: 'restartFailed', refusal: { code: 'execution_owner_reconciling' } }
    ],
    [
      'another operation in the way',
      { kind: 'startFailed', refusal: { code: 'agent_session_operation_conflict' } }
    ],
    [
      'ownership not yet settled',
      { kind: 'restartFailed', refusal: { code: 'agent_session_ownership_unknown' } }
    ]
  ] as const)('tries again a start refused before it ran by %s', (_situation, fact) => {
    expect(structuredAgentSessionStartRetryAt(fact, 1, FAILED_AT)).toBe(FAILED_AT + 15_000)
  })

  it.each([
    ['exited while starting', { kind: 'providerStartFailed' }],
    ['failed to start here', { kind: 'startFailed' }],
    [
      'failed its acquisition',
      { kind: 'restartFailed', refusal: { code: 'agent_session_operation_invalid' } }
    ],
    ['stopped by Orca after it hung', { kind: 'hostStopped' }],
    ['ended before it took the message', { kind: 'providerExited' }],
    ["Orca's own fault", { kind: 'hostFault' }]
  ] as const)('is done at once, for the Retry, when the start %s', (_situation, fact) => {
    expect(structuredAgentSessionStartRetryAt(fact, 1, FAILED_AT)).toBeNull()
  })

  it.each([
    ['signed out', { kind: 'notSignedIn' }],
    ['not installed', { kind: 'providerMissing' }],
    ['a launch setting to remove', { kind: 'managedAccountEnvOverride' }],
    ['an account Claude chats cannot use', { kind: 'managedAccountUnsupported' }],
    ['too much history to restore', { kind: 'historyTooLarge' }],
    [
      'a host with nothing to restart from',
      { kind: 'restartFailed', refusal: { code: 'structured_agent_session_unsupported' } }
    ]
  ] as const)('is done at once when %s: only the person can clear it', (_situation, fact) => {
    expect(structuredAgentSessionStartRetryAt(fact, 1, FAILED_AT)).toBeNull()
  })
})

function submission(patch: Partial<AgentJournalSubmission> = {}): AgentJournalSubmission {
  return {
    clientMessageId: 'cm_1',
    fence: 1,
    payloadFingerprint: 'fp',
    dispatchState: 'pending',
    providerItemId: null,
    reason: null,
    submittedAt: 1,
    resolvedAt: null,
    handoverRecorded: true,
    ...patch
  }
}

const RETRYING = submission({
  startFailure: {
    attempts: 1,
    reason: 'A Claude account switch is in progress.',
    rejection: { kind: 'accountSwitchInProgress' },
    failedAt: FAILED_AT,
    nextAttemptAt: FAILED_AT + 15_000
  }
})

const MESSAGE: AgentJournalRenderItem = {
  itemId: agentJournalSubmissionKey('cm_1'),
  revision: 1,
  body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hi' }] },
  sequence: 1,
  observedAt: 1
}

describe('a queued message waiting out a failed start', () => {
  it('is not work in progress: nothing runs for it until its next try', () => {
    expect(isRetryingStructuredAgentSessionStart(RETRYING)).toBe(true)
    expect(isStructuredAgentSessionMainAgentWorking(null, [RETRYING])).toBe(false)
    expect(isStructuredAgentSessionMainAgentWorking(null, [submission()])).toBe(true)
  })

  it('reads as a failed request in every session list, from when it failed', () => {
    expect(latestStructuredAgentSessionRequest([MESSAGE], [RETRYING])).toEqual({
      kind: 'refused-send',
      id: MESSAGE.itemId,
      turnState: null,
      outcome: 'failure',
      settledAt: FAILED_AT
    })
  })

  it('reaches a client whole, and a malformed record costs only the record', () => {
    expect(AgentJournalSubmissionSchema.parse(RETRYING)).toEqual(RETRYING)
    const damaged = AgentJournalSubmissionSchema.parse({
      ...RETRYING,
      startFailure: { attempts: 'one' }
    })
    expect(damaged).toEqual(submission())
  })
})
