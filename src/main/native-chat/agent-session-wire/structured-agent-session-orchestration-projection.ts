import {
  canonicalOrcaSessionId,
  createCanonicalOrcaSessionIdResolver
} from '../../runtime/orchestration/canonical-orca-session-id'
import {
  resolveLineageRunningSession,
  type AgentSessionRecordReader,
  type LineageRunningSession
} from '../../runtime/orchestration/structured-session-lineage'
import { isOrcaSessionId, type OrcaSessionId } from '../../../shared/orca-session-address'
import type { AgentSessionStatusSummary } from '../../../shared/agent-session-wire'

export type StructuredOrchestrationProjection = (
  sessionId: string,
  previousRoot?: string | null
) => string | null | undefined

/** Share both existing walks across one status snapshot, then discard their derived indexes. */
export function createStructuredOrchestrationProjection(
  records: Parameters<typeof projectStructuredOrchestrationSessionId>[1]
): StructuredOrchestrationProjection {
  if (!records.listRecords) {
    return () => undefined
  }
  const reader = { getRecord: records.getRecord, listRecords: records.listRecords }
  const rootOf = createCanonicalOrcaSessionIdResolver(reader)
  const running = new Map<string, LineageRunningSession>()
  return (sessionId, previousRoot) =>
    projectStructuredOrchestrationSessionId(sessionId, reader, previousRoot, rootOf, (root) => {
      let result = running.get(root)
      if (!result) {
        result = resolveLineageRunningSession(reader, root)
        running.set(root, result)
      }
      return result
    })
}

/** The current conversation owns its root; a reopened historical tab does not. */
export function projectStructuredOrchestrationSessionId(
  sessionId: string,
  records: Pick<AgentSessionRecordReader, 'getRecord'> &
    Partial<Pick<AgentSessionRecordReader, 'listRecords'>>,
  previousRoot?: string | null,
  rootOf?: (sessionId: OrcaSessionId) => OrcaSessionId,
  runningFrom?: (root: string) => LineageRunningSession
): string | null | undefined {
  if (!records.listRecords) {
    return undefined
  }
  if (!isOrcaSessionId(sessionId)) {
    return null
  }
  const reader = { getRecord: records.getRecord, listRecords: records.listRecords }
  // A root is immutable; reuse the published root, then re-derive its current owner.
  const root = previousRoot ?? rootOf?.(sessionId) ?? canonicalOrcaSessionId(sessionId, reader)
  const running = runningFrom?.(root) ?? resolveLineageRunningSession(reader, root)
  return running.kind === 'here' && running.sessionId === sessionId ? root : null
}

/** Re-read retained projections before reload snapshots, including closed historical sessions. */
export function refreshStructuredOrchestrationPublications<
  T extends { summary: AgentSessionStatusSummary }
>(
  published: Map<string, T>,
  records: Parameters<typeof projectStructuredOrchestrationSessionId>[1],
  broadcast: (summary: AgentSessionStatusSummary) => void,
  project?: StructuredOrchestrationProjection
): void {
  for (const [sessionId, publication] of published) {
    const root = project
      ? project(sessionId, publication.summary.orchestrationSessionId)
      : projectStructuredOrchestrationSessionId(
          sessionId,
          records,
          publication.summary.orchestrationSessionId
        )
    if (root === undefined || publication.summary.orchestrationSessionId === root) {
      continue
    }
    const summary = { ...publication.summary, orchestrationSessionId: root }
    published.set(sessionId, { ...publication, summary })
    broadcast(summary)
  }
}
