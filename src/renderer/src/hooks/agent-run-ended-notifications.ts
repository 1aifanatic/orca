import {
  getLiveAgentHookCompletionCoordinator,
  syncAgentHookCompletionNotificationSettings
} from './agent-hook-completion-notifications'

/** Completes the turn of a run reported only by its process lifetime (`opencode run`), which
 *  posts no Done: its exit is the turn end. Writes no status row. */
export function observeEndedAgentRunForNotification({
  paneKey,
  agentType,
  interrupted
}: {
  paneKey: string
  agentType: string
  interrupted: boolean
}): void {
  syncAgentHookCompletionNotificationSettings()
  // Why: only a lane that saw the run's Working has a turn to complete.
  getLiveAgentHookCompletionCoordinator(paneKey)?.observeAgentRunEnded({
    state: 'done',
    prompt: '',
    agentType,
    stateStartedAt: Date.now(),
    ...(interrupted ? { interrupted: true } : {})
  })
}
