import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { getStructuredAgentSessionStatusFeed } from '@/runtime/structured-agent-session-status-feed'
import type { AgentSessionStatusSummary } from '../../../shared/agent-session-wire'

type StartPhase = NonNullable<AgentSessionStatusSummary['hostExecutionPhase']>

const LOCAL = { kind: 'local' } as const

/**
 * Whether each chat's agent is still starting or has started, from the host's own status feed, so
 * a resuming row can say where it is without the resume reporting it. Null: not started yet.
 *
 * One subscription for the whole list, selected as a joined string so the snapshot is a PRIMITIVE
 * and a status change elsewhere does not re-render every row.
 */
export function useResumeRunStartPhases(
  sessionIds: readonly string[]
): (sessionId: string) => StartPhase | null {
  const feed = useMemo(() => getStructuredAgentSessionStatusFeed(LOCAL), [])
  const active = sessionIds.length > 0
  useEffect(() => (active ? feed.activate() : undefined), [feed, active])
  const key = sessionIds.join('\0')
  const joined = useSyncExternalStore(feed.subscribe, () =>
    key === ''
      ? ''
      : key
          .split('\0')
          .map((sessionId) => feed.getSnapshot().get(sessionId)?.hostExecutionPhase ?? '')
          .join('\0')
  )
  const phases = joined.split('\0')
  return (sessionId: string) => {
    const phase = phases[sessionIds.indexOf(sessionId)]
    return phase === 'starting' || phase === 'ready' ? phase : null
  }
}
