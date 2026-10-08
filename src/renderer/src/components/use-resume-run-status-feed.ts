import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { getStructuredAgentSessionStatusFeed } from '@/runtime/structured-agent-session-status-feed'
import type { AgentSessionStatusSummary } from '../../../shared/agent-session-wire'

export type ResumeRunHostStatus = Pick<
  AgentSessionStatusSummary,
  'restartResume' | 'hostExecutionPhase'
>
const LOCAL = { kind: 'local' } as const

/** Subscribe only to the selected chats' progress, so unrelated status ticks cost no render. */
export function useResumeRunStatusFeed(
  sessionIds: readonly string[]
): (sessionId: string) => ResumeRunHostStatus | undefined {
  const feed = useMemo(() => getStructuredAgentSessionStatusFeed(LOCAL), [])
  const active = sessionIds.length > 0
  useEffect(() => (active ? feed.activate() : undefined), [feed, active])
  const key = sessionIds.join('\0')
  const joined = useSyncExternalStore(feed.subscribe, () =>
    key === ''
      ? ''
      : key
          .split('\0')
          .map((sessionId) => {
            const summary = feed.getSnapshot().get(sessionId)
            return summary?.restartResume
              ? `${summary.restartResume.phase}:${summary.hostExecutionPhase ?? ''}`
              : ''
          })
          .join('\0')
  )
  const statuses = joined.split('\0')
  return (sessionId) => {
    const [phase, hostPhase] = (statuses[sessionIds.indexOf(sessionId)] ?? '').split(':')
    if (
      phase !== 'queued' &&
      phase !== 'starting' &&
      phase !== 'continued' &&
      phase !== 'refused' &&
      phase !== 'unconfirmed'
    ) {
      return undefined
    }
    return {
      restartResume: { phase },
      ...(hostPhase === 'starting' || hostPhase === 'ready'
        ? { hostExecutionPhase: hostPhase }
        : {})
    }
  }
}
