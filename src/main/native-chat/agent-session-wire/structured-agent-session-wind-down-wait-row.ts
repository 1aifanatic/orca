// The row a message waiting on an unfinished stop leaves in the chat: why it has not gone out.

import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import {
  agentSessionFailureWords,
  type AgentSessionFailureWordsContext
} from '../../../shared/agent-session-failure-words'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { isQueuedAgentJournalSubmission } from '../../../shared/agent-session-queued-submission'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemIdentity
} from '../../../shared/agent-session-journal-types'
import type {
  StructuredAgentSessionHostSession,
  StructuredAgentSessionProviderChildIdentity
} from './structured-agent-session-host-types'
import { pendingProviderChildWindDown } from './structured-agent-session-provider-child'

/** Keyed by the child the stop could not prove gone, so every send that waits on it shares a row. */
export function structuredAgentSessionWindDownWaitIdentity(
  owed: StructuredAgentSessionProviderChildIdentity
): AgentJournalItemIdentity {
  return {
    provider: 'orca',
    clientMessageId: `wind-down-wait:${owed.fence}:${owed.generation ?? 'unknown'}`
  }
}

type WaitingSession = Pick<
  StructuredAgentSessionHostSession,
  'journal' | 'child' | 'owesProviderChildWindDown'
>

function windDownWaitRow(
  session: WaitingSession,
  owed: StructuredAgentSessionProviderChildIdentity
) {
  const itemId = agentJournalItemKey(structuredAgentSessionWindDownWaitIdentity(owed))
  return session.journal.snapshot().items.find((item) => item.itemId === itemId)
}

/** Every queued message already waited through a retry of the owed stop: its row came after the
 *  newest. A new message retries again, and a retry that lands wakes the loop itself, so the row's
 *  own commit, which wakes the delivery loop, does not. */
export function structuredAgentSessionWindDownWaitHolds(session: WaitingSession): boolean {
  const owed = pendingProviderChildWindDown(session)
  const row = owed && windDownWaitRow(session, owed)
  if (!row) {
    return false
  }
  return session.journal
    .submissions()
    .every(
      (submission) =>
        !isQueuedAgentJournalSubmission(submission) ||
        (submission.acceptedSequence ?? 0) < row.sequence
    )
}

/** Written once per child, so every message that waits on it shares the row. */
export async function recordStructuredAgentSessionWindDownWait(
  session: WaitingSession,
  input: { fence: number; failureTextContext: AgentSessionFailureWordsContext }
): Promise<void> {
  const owed = pendingProviderChildWindDown(session)
  if (!owed || windDownWaitRow(session, owed)) {
    return
  }
  const identity = structuredAgentSessionWindDownWaitIdentity(owed)
  const words = agentSessionFailureWords(agentSessionFailureFact('previousExitUnverifiable'), {
    ...input.failureTextContext,
    surface: 'row'
  })
  await session.journal.appendItem(
    identity,
    { kind: 'status', tone: 'warning', ...words },
    { fence: input.fence, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
}
