import type { RuntimeMobileSessionTabsSnapshot } from '../../shared/runtime-types'
import type { RuntimeMobileSessionTerminalTab } from '../../shared/runtime-mobile-session-tab-contracts'
import { isNativeChatSupportedAgent } from '../../shared/native-chat-agent-support'

/**
 * A pane whose agent exit must change what clients show: `owner` is the chat-owning pane of a chat
 * tab; `legacy` is the sole pane of a tab nobody switched (absent `viewMode`) whose launch hint
 * lets the phone show it as chat by its own default.
 */
export type AgentExitChatViewCandidate = {
  kind: 'owner' | 'legacy'
  worktreeId: string
  parentTabId: string
  leafId: string
  ptyId: string
  /** The published incarnation of the pane's PTY, when the host publishes it. */
  incarnationId: string | null
}

function isChatOwnerRow(row: RuntimeMobileSessionTerminalTab, leafCount: number): boolean {
  if (row.viewMode !== 'chat') {
    return false
  }
  const owner = row.parentLayout?.chatLeafId
  // Why: a tab with one pane owns chat on that pane without an owner id.
  return owner ? owner === row.leafId : leafCount === 1
}

function isLegacyChatRow(row: RuntimeMobileSessionTerminalTab, leafCount: number): boolean {
  return (
    row.viewMode === undefined && leafCount === 1 && isNativeChatSupportedAgent(row.launchAgent)
  )
}

/** Re-derived from the published rows on every pass; nothing is stored between passes. */
export function collectAgentExitChatViewCandidates(
  snapshotsByWorktree: Iterable<[string, RuntimeMobileSessionTabsSnapshot]>
): AgentExitChatViewCandidate[] {
  const candidates: AgentExitChatViewCandidate[] = []
  for (const [worktreeId, snapshot] of snapshotsByWorktree) {
    const rows = snapshot.tabs.filter(
      (tab): tab is RuntimeMobileSessionTerminalTab => tab.type === 'terminal'
    )
    const leafCountByParent = new Map<string, number>()
    for (const row of rows) {
      leafCountByParent.set(row.parentTabId, (leafCountByParent.get(row.parentTabId) ?? 0) + 1)
    }
    for (const row of rows) {
      if (!row.ptyId) {
        continue
      }
      const leafCount = leafCountByParent.get(row.parentTabId) ?? 0
      const kind = isChatOwnerRow(row, leafCount)
        ? 'owner'
        : isLegacyChatRow(row, leafCount)
          ? 'legacy'
          : null
      if (kind) {
        candidates.push({
          kind,
          worktreeId,
          parentTabId: row.parentTabId,
          leafId: row.leafId,
          ptyId: row.ptyId,
          incarnationId: row.incarnationId ?? null
        })
      }
    }
  }
  return candidates
}

/** The candidate rows a proven exit of `ptyId` affects, from the current publication. */
export function findAgentExitChatViewCandidatesForPty(
  snapshotsByWorktree: Iterable<[string, RuntimeMobileSessionTabsSnapshot]>,
  ptyId: string
): AgentExitChatViewCandidate[] {
  return collectAgentExitChatViewCandidates(snapshotsByWorktree).filter(
    (candidate) => candidate.ptyId === ptyId
  )
}
