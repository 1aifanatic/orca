// A /compact that waited out a refused start, gone past by a later message whose turn is running
// when the /compact's try comes due: it waits for that turn, whichever agent runs it. Claude names a
// turn's sender by the provider echo the message adopted, not by the message's own key.

import { describe, expect, it } from 'vitest'
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import {
  agentJournalItemKey,
  agentJournalSubmissionKey
} from '../../../shared/agent-session-journal-item-key'
import type {
  AgentJournalMessageItem,
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../shared/agent-session-journal-types'
import { commandBlocked } from './structured-agent-session-command-handover-block'

const SUBMISSION = {
  fence: 1,
  payloadFingerprint: 'fp',
  providerItemId: null,
  reason: null,
  submittedAt: 1,
  resolvedAt: null,
  handoverRecorded: true
} satisfies Partial<AgentJournalSubmission>
const COMPACT: AgentJournalMessageItem = {
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text: '/compact' }],
  command: { name: 'compact' }
}
const CLAUDE_ECHO = agentJournalItemKey({ provider: 'claude', sessionId: 'cs', uuid: 'u-2' })

/** The waiting /compact's handover, with a running turn whose sender is `userItemId`. */
function handover(input: {
  userItemId: string | undefined
  laterProviderItemId: string | null
  laterAcceptedSequence: number
}) {
  const command: AgentJournalSubmission = {
    ...SUBMISSION,
    clientMessageId: 'compact',
    dispatchState: 'pending',
    acceptedSequence: 2,
    startRetry: {
      attempts: 1,
      reason: 'A Claude account switch is in progress.',
      rejection: agentSessionFailureFact('accountSwitchInProgress'),
      failedAt: 10,
      nextAttemptAt: 20
    }
  }
  const later: AgentJournalSubmission = {
    ...SUBMISSION,
    clientMessageId: 'later',
    dispatchState: 'accepted',
    acceptedSequence: input.laterAcceptedSequence,
    providerItemId: input.laterProviderItemId,
    resolvedAt: 5
  }
  const items: AgentJournalRenderItem[] = [
    {
      itemId: agentJournalSubmissionKey('later'),
      revision: 0,
      sequence: 4,
      observedAt: 4,
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'second' }] }
    },
    {
      itemId: 'turn-row',
      revision: 1,
      sequence: 5,
      observedAt: 5,
      body: {
        kind: 'turn',
        turnId: 't2',
        state: 'running',
        ...(input.userItemId ? { userItemId: input.userItemId } : {})
      }
    }
  ]
  const ctx = {
    sessionId: 's',
    fence: 1,
    journal: { snapshot: () => ({ items }), submissions: () => [command, later] },
    adapter: { compact: () => undefined },
    record: () => ({ lease: {} }),
    childWork: () => []
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a handover context carrying only what the turn-active check reads.
  return commandBlocked(ctx as never, command, COMPACT)
}

describe('a /compact gone past by a later message whose turn is running', () => {
  it.each([
    ['Codex, naming the message by its own key', agentJournalSubmissionKey('later'), null],
    ['Claude, naming the message by the echo it adopted', CLAUDE_ECHO, CLAUDE_ECHO]
  ])('waits for that turn: %s', (_agent, userItemId, laterProviderItemId) => {
    expect(handover({ userItemId, laterProviderItemId, laterAcceptedSequence: 3 })).toBe('waits')
  })

  it('is refused behind a turn the provider opened on its own', () => {
    expect(
      handover({ userItemId: undefined, laterProviderItemId: null, laterAcceptedSequence: 3 })
    ).toMatchObject({ kind: 'commandRefused' })
  })

  it('is refused behind a turn a message accepted before it runs', () => {
    expect(
      handover({
        userItemId: CLAUDE_ECHO,
        laterProviderItemId: CLAUDE_ECHO,
        laterAcceptedSequence: 1
      })
    ).toMatchObject({ kind: 'commandRefused' })
  })
})
