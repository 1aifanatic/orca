import { useCallback, useLayoutEffect, useMemo, useRef } from 'react'
import { agentJournalSubmissionKey } from '../../../../shared/agent-session-journal-item-key'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session-journal-types'

/** Which sent messages' own rows the loaded journal pages hold: a rejected message's outbox entry
 *  draws it until its row is here. `loadedItemIds` stays the same set while the user rows don't
 *  change, so a streaming turn re-runs nothing; `rowLoaded` reads the latest at call time. */
export function useStructuredAgentSessionLoadedUserRows(items: readonly AgentJournalRenderItem[]): {
  loadedItemIds: ReadonlySet<string>
  rowLoaded: (clientMessageId: string) => boolean
} {
  const key = useMemo(
    () =>
      items
        .filter((item) => item.body.kind === 'message' && item.body.role === 'user')
        .map((item) => item.itemId)
        .join('\0'),
    [items]
  )
  const loadedItemIds = useMemo(() => new Set(key === '' ? [] : key.split('\0')), [key])
  const loadedRef = useRef(loadedItemIds)
  useLayoutEffect(() => {
    loadedRef.current = loadedItemIds
  }, [loadedItemIds])
  const rowLoaded = useCallback(
    (clientMessageId: string) => loadedRef.current.has(agentJournalSubmissionKey(clientMessageId)),
    []
  )
  return { loadedItemIds, rowLoaded }
}
