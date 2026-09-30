// One structured session's status row, built the same way whether its projected fields come from
// an open journal or from the state stored beside it (journal-session-state.ts), so a row seeded
// at startup and the row the chat's open later publishes are equal field for field.

import { agentProviderSessionsEqual } from '../../../shared/agent-session-resume'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import { normalizeOptionalField } from '../../../shared/agent-status-field-normalization'
import { isAgentStatusHeldOpenByChildWork } from '../../../shared/agent-lead-status-fold'
import { AGENT_MODEL_MAX_LENGTH } from '../../../shared/agent-status-types'
import {
  agentSessionBackgroundTasksEqual,
  type AgentSessionBackgroundTaskState,
  type AgentSessionStatusSummary
} from '../../../shared/agent-session-wire'
import type { StructuredAgentSessionStatusProjection } from '../../../shared/structured-agent-session-projection'
import { structuredAgentSessionAgentStatus } from '../../../shared/structured-agent-session-agent-status'
import type { StructuredAgentSessionProviderChild } from './structured-agent-session-host-types'
import { structuredAgentSessionProviderSessionMetadata } from './structured-agent-session-history-result'

export function structuredAgentSessionStatusSummary(input: {
  sessionId: string
  params: { location: AgentSessionRecord['location']; provider: AgentSessionRecord['provider'] }
  record: AgentSessionRecord | null
  child?: Pick<StructuredAgentSessionProviderChild, 'phase' | 'generation' | 'fence'> | null
  projected: StructuredAgentSessionStatusProjection
  backgroundTasks?: AgentSessionBackgroundTaskState | null
  /** The journal's newest activity; 0 when it can date none. */
  lastActivityAt: number
  now: () => number
}): AgentSessionStatusSummary {
  const { record, child } = input
  const providerSession = structuredAgentSessionProviderSessionMetadata(record)
  // The journal has no model: the record's acknowledged options are where a mid-session
  // switch lands, so the row follows whichever is in force.
  const model = normalizeOptionalField(record?.options?.model, AGENT_MODEL_MAX_LENGTH)
  // Usage is dropped here on purpose: a `task_progress` tick would otherwise fail the
  // equality check and re-broadcast a full summary to every remote subscriber for a
  // number no session list renders. Tokens stay live on the background-task channel.
  const backgroundTasks = input.backgroundTasks?.tasks?.map(
    ({ totalTokens: _totalTokens, ...task }) => task
  )
  return {
    sessionId: input.sessionId,
    workspaceId: input.params.location.workspaceId,
    agent: input.params.provider,
    ...(child
      ? {
          hostExecutionOwned: true as const,
          hostExecutionPhase: child.phase,
          hostExecutionChild: { generation: child.generation, fence: child.fence }
        }
      : {}),
    ...input.projected,
    ...(record?.rewind?.phase === 'prepared' || record?.rewind?.phase === 'provider-succeeded'
      ? { rewindBlockedReason: 'outcome-unknown' as const }
      : {}),
    ...(model ? { model } : {}),
    ...(backgroundTasks && backgroundTasks.length > 0 ? { backgroundTasks } : {}),
    ...(providerSession ? { providerSession } : {}),
    updatedAt: input.lastActivityAt || input.now()
  }
}

export function structuredAgentSessionSummariesEqual(
  a: AgentSessionStatusSummary,
  b: AgentSessionStatusSummary
): boolean {
  return (
    a.workspaceId === b.workspaceId &&
    a.agent === b.agent &&
    a.status === b.status &&
    a.hostExecutionOwned === b.hostExecutionOwned &&
    a.hostExecutionPhase === b.hostExecutionPhase &&
    a.hostExecutionChild?.generation === b.hostExecutionChild?.generation &&
    a.hostExecutionChild?.fence === b.hostExecutionChild?.fence &&
    a.rewindBlockedReason === b.rewindBlockedReason &&
    // A moved state clock changes ranking; row activity alone, including a subagent's, does not.
    // An idle state the journal cannot date still republishes, since readers date it by `updatedAt`,
    // and so does one live child work holds open: readers take each publish as its evidence.
    a.statusStartedAt === b.statusStartedAt &&
    (a.status !== 'idle' ||
      a.updatedAt === b.updatedAt ||
      (a.statusStartedAt !== undefined && !isIdleHeldOpenByChildWork(b))) &&
    a.latestPrompt === b.latestPrompt &&
    a.model === b.model &&
    a.toolName === b.toolName &&
    a.toolInput === b.toolInput &&
    a.lastAssistantMessage === b.lastAssistantMessage &&
    a.turnOutcome === b.turnOutcome &&
    agentSessionBackgroundTasksEqual(a.backgroundTasks, b.backgroundTasks) &&
    agentProviderSessionsEqual(undefined, a.providerSession, b.providerSession)
  )
}

function isIdleHeldOpenByChildWork(summary: AgentSessionStatusSummary): boolean {
  return (
    summary.status === 'idle' &&
    isAgentStatusHeldOpenByChildWork(
      structuredAgentSessionAgentStatus({
        status: summary.status,
        backgroundTasks: summary.backgroundTasks,
        turnOutcome: summary.turnOutcome
      })
    )
  )
}
