import type { OrchestrationDb } from '../../../../orchestration/db'
import { routeAllMailboxPages } from '../schemas'

type RoutePage = (throughSequence: number) => { routedCount: number; hasMore: boolean }

/** Routes a direct mailbox's unread mail up to its latest sequence now, page by page. */
export function directMailboxSnapshotRouter(
  db: OrchestrationDb,
  signal: AbortSignal | undefined
): (runId: string, directHandle: string, routePage: RoutePage) => Promise<void> {
  return async (runId, directHandle, routePage) => {
    const throughSequence = db.getLatestUnreadDirectMessageSequenceForRun(runId, directHandle)
    if (throughSequence !== undefined) {
      await routeAllMailboxPages(() => routePage(throughSequence), signal)
    }
  }
}
