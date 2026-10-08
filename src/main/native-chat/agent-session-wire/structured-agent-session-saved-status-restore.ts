// What startup owes native chat statuses. Each listed chat shows its saved status without its
// history being opened. Only the chats the restart cut mid-turn are opened, at once, so their
// journals settle at the restart boundary rather than whenever someone next looks.

import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentSessionStatusSummary } from '../../../shared/agent-session-wire'
import { agentTurnVerdict } from '../../../shared/agent-turn-outcome'
import type { SavedStructuredSessionStatus } from '../../../shared/structured-agent-session-saved-status'
import type { StructuredAgentSessionLogger } from './structured-agent-session-logger'
import { turnVerdictFromDeathEvidence } from './structured-agent-session-stale-turn-verdict'

function wasCut(saved: SavedStructuredSessionStatus): boolean {
  return saved.summary.status === 'working' || saved.summary.status === 'attention'
}

/** What the chat's next open says. Its agent did not outlive the last Orca, so a turn it ran or a
 *  prompt it waited on ends with the verdict the journal's settle gives it, from the same proof. */
export function settledSavedStructuredSessionSummary(
  saved: SavedStructuredSessionStatus,
  record: AgentSessionRecord
): AgentSessionStatusSummary {
  const { conversationName: _saved, statusStartedAt, ...rest } = saved.summary
  const summary = {
    ...rest,
    agent: record.provider,
    workspaceId: record.location.workspaceId,
    ...(record.conversationName ? { conversationName: record.conversationName } : {})
  }
  if (!wasCut(saved)) {
    return { ...summary, ...(statusStartedAt ? { statusStartedAt } : {}) }
  }
  const verdict = turnVerdictFromDeathEvidence(record.lease.deathEvidence, saved.turnFence)
  return {
    ...summary,
    status: 'idle',
    turnOutcome: agentTurnVerdict({ state: verdict.state, outcome: null }) ?? 'unconfirmed',
    ...(verdict.state === 'interrupted' ? { statusStartedAt: verdict.completedAt } : {})
  }
}

/** Runs after the startup lease check, which writes the death proofs the verdict reads. A failed
 *  settle is logged: the chat still lists, and its own open settles it again. */
export async function restoreSavedStructuredAgentSessionStatuses(input: {
  listed: readonly string[]
  saved: readonly SavedStructuredSessionStatus[]
  getRecord: (sessionId: string) => AgentSessionRecord | null
  restoreSaved: (
    summary: AgentSessionStatusSummary,
    location: AgentSessionRecord['location']
  ) => void
  dropSaved: (sessionId: string) => void
  /** Opens each chat, which settles what its gone agent left running. */
  settle: (sessionIds: readonly string[]) => Promise<void>
  close: (sessionId: string) => Promise<void>
  logger: StructuredAgentSessionLogger
}): Promise<void> {
  const listed = new Set(input.listed)
  const cut: string[] = []
  for (const saved of input.saved) {
    const { sessionId } = saved.summary
    const record = input.getRecord(sessionId)
    if (record && listed.has(sessionId)) {
      input.restoreSaved(settledSavedStructuredSessionSummary(saved, record), record.location)
    } else if (!record || !wasCut(saved)) {
      // Nothing lists it, and nothing of it is left to settle.
      input.dropSaved(sessionId)
    }
    if (record && wasCut(saved)) {
      cut.push(sessionId)
    }
  }
  if (cut.length === 0) {
    return
  }
  await input.settle(cut).catch((error: unknown) => {
    input.logger.warn('settling chats a restart cut failed', {
      scope: 'saved-status-settle',
      sessionIds: cut,
      error
    })
  })
  for (const sessionId of cut.filter((id) => !listed.has(id))) {
    await input.close(sessionId).catch((error: unknown) => {
      input.logger.warn('closing a settled unlisted chat failed', {
        scope: 'saved-status-close',
        sessionId,
        error
      })
    })
    input.dropSaved(sessionId)
  }
}
