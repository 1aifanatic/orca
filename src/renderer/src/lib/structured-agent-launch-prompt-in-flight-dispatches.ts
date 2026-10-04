// The launch prompt sends in flight, by entry and fence. A provisional chat can mount before its
// launch settlement runs; both own the same persisted entry, so they share one in-flight send
// instead of issuing two RPCs.

import type { StructuredAgentSessionSendSettlement } from '../../../shared/structured-agent-session-send-settlement'

/** How the send settled, or null when nothing was sent. */
export type StructuredAgentLaunchPromptDispatch =
  Promise<StructuredAgentSessionSendSettlement | null>

const inFlightDispatches = new Map<string, StructuredAgentLaunchPromptDispatch>()

function dispatchKey(sessionId: string, clientMessageId: string, fence: number): string {
  return `${sessionId}:${clientMessageId}:${fence}`
}

export function getStructuredAgentLaunchPromptDispatch(
  sessionId: string,
  clientMessageId: string,
  fence?: number
): StructuredAgentLaunchPromptDispatch | undefined {
  if (fence !== undefined) {
    return inFlightDispatches.get(dispatchKey(sessionId, clientMessageId, fence))
  }
  const prefix = `${sessionId}:${clientMessageId}:`
  for (const [key, promise] of inFlightDispatches) {
    if (key.startsWith(prefix)) {
      return promise
    }
  }
  return undefined
}

export function shareStructuredAgentLaunchPromptDispatch(
  sessionId: string,
  clientMessageId: string,
  fence: number,
  start: () => StructuredAgentLaunchPromptDispatch
): { promise: StructuredAgentLaunchPromptDispatch; started: boolean } {
  const key = dispatchKey(sessionId, clientMessageId, fence)
  const existing = inFlightDispatches.get(key)
  if (existing) {
    return { promise: existing, started: false }
  }
  const promise = Promise.resolve().then(start)
  inFlightDispatches.set(key, promise)
  const clear = (): void => {
    if (inFlightDispatches.get(key) === promise) {
      inFlightDispatches.delete(key)
    }
  }
  void promise.then(clear, clear)
  return { promise, started: true }
}
