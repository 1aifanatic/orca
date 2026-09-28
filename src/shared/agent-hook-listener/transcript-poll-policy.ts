import type { AgentHookSource } from '../agent-hook-relay'
import type { AgentHookEventPayload } from './listener-event'
import type { HookListenerState } from './listener-state'
import {
  codexRolloutCanSettleMainAgent,
  hasCodexTranscriptSubagents
} from './providers/codex-state'
import { hasMuseSessionLog } from './providers/muse-events'

/** Whether a pane's last hook body should be re-normalized on a timer to pick up transcript-only state. */
export function shouldPollHookTranscript(
  state: HookListenerState,
  source: AgentHookSource,
  event: AgentHookEventPayload
): boolean {
  if (source === 'codex') {
    // Why: Codex records a turn's end in its rollout even when its Interrupt or Stop hook is lost,
    // so polling while the turn is open recovers that hook within a tick; it stops once it ends.
    return (
      hasCodexTranscriptSubagents(state, event.paneKey) ||
      codexRolloutCanSettleMainAgent(state, event.paneKey)
    )
  }
  if (source === 'muse') {
    // Why: Muse's question tool fires no hook, so only its session log shows the wait and its answer.
    return event.payload.state !== 'done' && hasMuseSessionLog(state, event.paneKey)
  }
  return false
}

/** Returns the poll result to publish, or undefined when it carries nothing new. */
export function transcriptPollUpdate<T extends AgentHookEventPayload>(
  source: AgentHookSource,
  original: T,
  polled: T
): T | undefined {
  if (source === 'muse') {
    const changed =
      polled.payload.state !== original.payload.state ||
      polled.payload.interactivePrompt !== original.payload.interactivePrompt
    // Why: a replayed UserPromptSubmit body is neither a newly sent prompt nor a turn boundary.
    return changed
      ? { ...polled, hasExplicitPrompt: undefined, hookEventName: undefined }
      : undefined
  }
  const changed =
    polled.payload.state !== original.payload.state ||
    polled.payload.mainAgent?.state !== original.payload.mainAgent?.state ||
    polled.payload.mainAgent?.outcome !== original.payload.mainAgent?.outcome ||
    JSON.stringify(polled.payload.subagents) !== JSON.stringify(original.payload.subagents)
  return changed ? polled : undefined
}
