import { agentChildWorkViewOffersStop } from '../../../shared/agent-child-row-model'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import { agentChildWorkLiveness } from '../../../shared/agent-status-child-work-liveness'
import type { AgentChildWorkView } from '../../../shared/agent-status-child-work-view'
import { activeStructuredAgentSessionTurnId } from '../../../shared/structured-agent-session-projection'
import type { AgentSessionBackgroundTaskStops } from './structured-agent-session-adapter'
import type { AgentSessionTurnContext } from './structured-agent-session-turns'
import {
  refuse,
  type AgentSessionRefusalReason,
  type AgentSessionWireRefusal
} from '../../../shared/agent-session-wire-refusals'

function blocked(
  reason: AgentSessionRefusalReason<'agent_session_operation_invalid'>,
  message: string
): AgentSessionWireRefusal {
  return refuse('agent_session_operation_invalid', { reason }, message)
}

/** `childWork` is the session's child records as the chat strip reads them: a refusal may only
 *  cite work the strip lists, and ask for a stop only when the strip offers one. */
export function conversationCommandBlocked(
  ctx: AgentSessionTurnContext,
  record: AgentSessionRecord,
  childWork: readonly AgentChildWorkView[] | undefined
): AgentSessionWireRefusal | null {
  const items = ctx.journal.snapshot().items
  if (record.rewind?.phase === 'prepared' || record.rewind?.phase === 'provider-succeeded') {
    return blocked('rewindUnconfirmed', 'agent_session_rewind:outcome-unknown')
  }
  if (
    record.conversationCommand?.command === 'clear' &&
    record.conversationCommand.phase === 'committed' &&
    record.conversationCommand.replacementSessionId
  ) {
    return blocked(
      'conversationCleared',
      'This conversation has been cleared. Open the current conversation to continue.'
    )
  }
  if (
    record.conversationCommand?.state === 'unknown' &&
    record.conversationCommand.phase === 'prepared'
  ) {
    return blocked(
      'conversationCommandUnconfirmed',
      'The previous conversation operation is unconfirmed.'
    )
  }
  if (record.lease.handoffStage || record.lease.handoffOperationId) {
    return blocked('handoffInFlight', 'Wait for the session handoff to finish.')
  }
  if (activeStructuredAgentSessionTurnId(items)) {
    return blocked('turnActive', 'Wait for the current turn to finish before using this command.')
  }
  if (
    items.some(
      (item) =>
        (item.body.kind === 'approval' || item.body.kind === 'question') &&
        item.body.resolution.state === 'pending'
    )
  ) {
    return blocked(
      'promptPending',
      'Resolve the pending question or approval before using this command.'
    )
  }
  // The same liveness fold the strip's monitoring indicator reads: settled rows block nothing.
  if (agentChildWorkLiveness(childWork) !== null) {
    return blocked(
      'backgroundTasksRunning',
      stripOffersStop(childWork ?? [], ctx.adapter.backgroundTaskStops?.(ctx.sessionId))
        ? 'Stop background tasks before using this command.'
        : 'Wait for background tasks to finish before using this command.'
    )
  }
  if (
    ctx.journal.submissions().some(
      (entry) =>
        entry.dispatchState === 'pending' ||
        // Doubt left by an earlier child is not this one's work in flight.
        (entry.dispatchState === 'unknown' && entry.recovered !== true && entry.fence === ctx.fence)
    )
  ) {
    return blocked(
      'messagesUnsettled',
      'Resolve pending or unconfirmed messages before using this command.'
    )
  }
  return null
}

/** The strip's own stop controls: a per-row stop where the provider can target one, else its
 *  single untargeted stop. Asking for a stop it does not render names a control nobody can use. */
function stripOffersStop(
  childWork: readonly AgentChildWorkView[],
  stops: AgentSessionBackgroundTaskStops | undefined
): boolean {
  if (!stops) {
    return false
  }
  return stops.supportsTaskStop
    ? childWork.some(agentChildWorkViewOffersStop)
    : stops.supportsStopAll
}
