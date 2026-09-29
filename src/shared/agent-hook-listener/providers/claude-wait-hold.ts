import { continueMainAgentStatus } from '../../agent-lead-status-fold'
import type { ClaudeLeadTurnState, HookListenerState } from '../listener-state'
import {
  claudeWaitIsChildOwned,
  type ClaudeAnnouncedCalls,
  type ClaudeApprovalRecord
} from './claude-approval-ledger'
import { setClaudeMainAgentTurnState } from './claude-roster-state'

/** Re-state an outstanding wait over new activity. When only children are owed answers the main
 *  agent is not blocked, so its own progress is recorded behind the wait: restart seeds the main
 *  agent from it, and a stale `done` would let the children's drain settle a row it still works. */
export function holdClaudeWait(
  state: HookListenerState,
  paneKey: string,
  lead: ClaudeLeadTurnState,
  approvals: readonly ClaudeApprovalRecord[],
  announcedCalls: ClaudeAnnouncedCalls | undefined,
  mainAgentProgress: Pick<ClaudeLeadTurnState, 'state' | 'outcome' | 'turnCompletedAt'>
): void {
  const { announcedCalls: _announced, stateBeforeWait: stash, ...record } = lead
  const behind = claudeWaitIsChildOwned(approvals)
    ? {
        state: mainAgentProgress.state,
        ...(mainAgentProgress.outcome ? { outcome: mainAgentProgress.outcome } : {}),
        stateStartedAt: continueMainAgentStatus(stash, mainAgentProgress, Date.now())
          .stateStartedAt,
        ...(mainAgentProgress.turnCompletedAt !== undefined
          ? { turnCompletedAt: mainAgentProgress.turnCompletedAt }
          : {})
      }
    : stash
  setClaudeMainAgentTurnState(state, paneKey, {
    ...record,
    approvals,
    ...(announcedCalls ? { announcedCalls } : {}),
    ...(behind ? { stateBeforeWait: behind } : {})
  })
}
