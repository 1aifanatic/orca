import { shallow } from 'zustand/shallow'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import type { AgentPresenceByPaneKey, AgentPresenceRecord } from '@/store/slices/agent-presence'

const EMPTY_PRESENCE: AgentPresenceByPaneKey = Object.freeze({})
let previousPresence: AgentPresenceByPaneKey | undefined
let byTab = new Map<string, AgentPresenceByPaneKey>()

/** One index per host publication, shared by mounted panes and activity readers. */
export function selectAgentPresencesForTab(
  presence: AgentPresenceByPaneKey | undefined,
  tabId: string
): AgentPresenceByPaneKey {
  if (presence !== previousPresence) {
    const next = new Map<string, Record<string, AgentPresenceRecord>>()
    for (const [paneKey, record] of Object.entries(presence ?? {})) {
      const pane = parsePaneKey(paneKey)
      if (!pane) {
        continue
      }
      const bucket = next.get(pane.tabId) ?? {}
      bucket[paneKey] = record
      next.set(pane.tabId, bucket)
    }
    const stabilized = new Map<string, AgentPresenceByPaneKey>()
    for (const [id, bucket] of next) {
      const previous = byTab.get(id)
      stabilized.set(id, previous && shallow(previous, bucket) ? previous : bucket)
    }
    byTab = stabilized
    previousPresence = presence
  }
  return byTab.get(tabId) ?? EMPTY_PRESENCE
}

/** Prefer the focused owner, then a surviving split sibling; keep ended evidence through layout hydration. */
export function selectTabAgentPresence(
  presence: AgentPresenceByPaneKey | undefined,
  tabId: string,
  focusedPaneKey: string | null
) {
  const records = selectAgentPresencesForTab(presence, tabId)
  const focused = focusedPaneKey ? records[focusedPaneKey]?.presence : undefined
  if (focused?.process && !focused.ended) {
    return focused
  }
  const owners = Object.values(records)
    .map((record) => record.presence)
    .filter((owner) => owner.process)
  return owners.find((owner) => !owner.ended) ?? (focused?.process ? focused : owners[0])
}
