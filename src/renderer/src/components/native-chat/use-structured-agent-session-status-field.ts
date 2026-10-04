// One field of the host's projected session status, read from the live status feed.

import { useEffect, useMemo, useSyncExternalStore } from 'react'
import type { AgentSessionStatusSummary } from '../../../../shared/agent-session-wire'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import { getStructuredAgentSessionStatusFeed } from '@/runtime/structured-agent-session-status-feed'

/** One field of the host's status, so a chat re-renders when that changes, not on every status. */
export function useStructuredAgentSessionStatusField<T extends string | boolean | null>(
  sessionId: string,
  target: RuntimeClientTarget,
  read: (summary: AgentSessionStatusSummary | undefined) => T,
  initial: T
): T {
  const feed = useMemo(() => getStructuredAgentSessionStatusFeed(target), [target])
  useEffect(() => feed.activate(), [feed])
  return useSyncExternalStore(
    feed.subscribe,
    () => read(feed.getSnapshot().get(sessionId)),
    () => initial
  )
}

/** The host refuses every send while a rewind's outcome is unknown, the same record check as its
 *  send block, so the chat's queue sends nothing then. */
export function useStructuredAgentSessionRewindBlocksSends(
  sessionId: string,
  target: RuntimeClientTarget
): boolean {
  return useStructuredAgentSessionStatusField(
    sessionId,
    target,
    (summary) => summary?.rewindBlockedReason !== undefined,
    false
  )
}
