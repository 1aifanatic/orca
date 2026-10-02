import type { useStructuredAgentSession } from './use-structured-agent-session'

type StopController = Pick<
  ReturnType<typeof useStructuredAgentSession>,
  'canStop' | 'stopPressed' | 'stop' | 'queuedMessages'
>

/**
 * The chat pane's Stop state. It reads "Stopping…" from the host's word, bridged by this client's
 * own press until its Stop event lands. Only that press in flight holds Stop, since a repeat is how
 * a stuck stop escalates. While it reads Stopping nothing steers into the turn: a message sent then
 * runs after it.
 */
export function nativeChatStructuredStopControls(
  controller: StopController,
  hostStopping: boolean
): {
  stopping: boolean
  composer: {
    isStopping: boolean
    onStop: () => void
    steerQueued: (() => boolean) | undefined
    queuesAfterStop: boolean
  }
} {
  const stopping = controller.canStop && (hostStopping || controller.stopPressed)
  const stopInFlight = controller.canStop && controller.stopPressed
  return {
    stopping,
    composer: {
      isStopping: stopInFlight,
      onStop: () => void (stopInFlight || controller.stop()),
      steerQueued: stopping ? undefined : controller.queuedMessages.steerNewest,
      queuesAfterStop: stopping
    }
  }
}
