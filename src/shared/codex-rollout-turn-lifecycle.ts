// Codex's own record of a turn's lifecycle in its rollout. Both the native-chat transcript
// decoders and the hook lane's rollout reconcile read it, so they cannot disagree about which
// line starts, completes or aborts a turn.
import type { NativeChatTurnLifecycleState } from './native-chat-types'
import { record, type JsonRecord } from './codex-rollout-jsonl-cursor'

/** Codex `event_msg` payload types that bound a turn's lifecycle. */
export const CODEX_EVENT_TURN_STARTED = 'task_started'
export const CODEX_EVENT_TURN_COMPLETE = 'task_complete'
export const CODEX_EVENT_TURN_ABORTED = 'turn_aborted'

export type CodexRolloutTurnLifecycle = {
  state: NativeChatTurnLifecycleState
  /** The turn's `turn_id`, the same id Codex puts on that turn's hooks. */
  turnId?: string
}

export function decodeCodexRolloutTurnLifecycle(
  recordValue: JsonRecord
): CodexRolloutTurnLifecycle | undefined {
  const payload = record(recordValue.payload)
  if (recordValue.type !== 'event_msg' || !payload) {
    return undefined
  }
  const state =
    payload.type === CODEX_EVENT_TURN_STARTED
      ? 'working'
      : payload.type === CODEX_EVENT_TURN_COMPLETE
        ? 'completed'
        : payload.type === CODEX_EVENT_TURN_ABORTED
          ? 'interrupted'
          : undefined
  if (!state) {
    return undefined
  }
  const turnId = typeof payload.turn_id === 'string' ? payload.turn_id.trim() : ''
  return turnId ? { state, turnId } : { state }
}
