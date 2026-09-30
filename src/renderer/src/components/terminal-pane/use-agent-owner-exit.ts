import { useEffect } from 'react'
import type { AgentPresenceByPaneKey } from '@/store/slices/agent-presence'
import { makePaneKey } from '../../../../shared/stable-pane-id'

/** Deliver the host exit even when no terminal bytes or foreground changes arrive. */
export function useAgentOwnerExit(
  records: AgentPresenceByPaneKey,
  tabId: string,
  leafId: string | null,
  onExit: (leafId: string) => void
): void {
  useEffect(() => {
    if (!leafId) {
      return
    }
    const presence = records[makePaneKey(tabId, leafId)]?.presence
    if (presence?.process && presence.ended) {
      onExit(leafId)
    }
  }, [records, tabId, leafId, onExit])
}
