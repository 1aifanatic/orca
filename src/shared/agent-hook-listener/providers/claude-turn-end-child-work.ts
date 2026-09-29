import type { ClaudeBackgroundAgentTask } from '../../claude-background-task-inventory'
import {
  foldClaudeBackgroundTasksIntoRoster,
  reapUnconfirmedRestoredClaudeSubagents
} from '../../claude-subagent-roster'
import type { HookListenerState } from '../listener-state'
import { getOrCreateClaudeSubagentRoster, resolveClaudePaneStatus } from './claude-roster-state'

/** Retire the child work a main agent turn end proves gone, and report whether any still outlives
 *  the turn — which is what decides whether a child's prompt survives it. */
export function foldClaudeTurnEndChildWork(
  state: HookListenerState,
  paneKey: string,
  turnEnd: {
    backgroundTasks: { present: boolean; tasks: ClaudeBackgroundAgentTask[]; truncated: boolean }
    manualCompact: boolean
  }
): boolean {
  const { backgroundTasks } = turnEnd
  // Why: background_tasks is trusted only where unambiguous (see foldClaudeBackgroundTasksIntoRoster) — teammates report "running" here even while idle.
  // Older Claude builds without the field keep the incrementally tracked roster.
  if (!turnEnd.manualCompact && backgroundTasks.present) {
    foldClaudeBackgroundTasksIntoRoster(
      getOrCreateClaudeSubagentRoster(state, paneKey),
      backgroundTasks.tasks,
      Date.now(),
      { inventoryComplete: !backgroundTasks.truncated }
    )
  }
  if (turnEnd.manualCompact) {
    // Why: a manual /compact only ever completes at an idle prompt, so a child that exists ONLY as
    // a disk snapshot has nothing live behind it and must not keep the pane spinning — that
    // restored child is what holds the stuck row STA-2915 actually reports. Everything else the
    // done-gate consults is live evidence (a child observed in this runtime, an unclassifiable
    // running background task, a registered session cron) and still holds the pane.
    const restoredRoster = state.claudeSubagentRosterByPaneKey.get(paneKey)
    if (
      restoredRoster &&
      reapUnconfirmedRestoredClaudeSubagents(restoredRoster) &&
      restoredRoster.size === 0
    ) {
      state.claudeSubagentRosterByPaneKey.delete(paneKey)
    }
  }
  return resolveClaudePaneStatus(state, paneKey, { state: 'done' }).stateName !== 'done'
}
