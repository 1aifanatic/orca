import type { RuntimeMobileSessionTerminalTab } from '../../shared/runtime-types'
import type { TerminalTab } from '../../shared/terminal-tab-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import {
  isNativeChatTabWideFallbackSafe,
  nativeChatLaunchAgentForLeaf,
  resolveNativeChatActiveLayoutLeafId
} from '../../shared/native-chat-leaf-ownership'
import {
  normalizeTerminalChatPair,
  resolveTerminalTabViewMode
} from '../../shared/terminal-tab-view-mode'
import {
  cloneTerminalLayoutSnapshot,
  collectPersistedTerminalLeafIds,
  deriveHeadlessLegacyTerminalLeafId,
  isPersistedTerminalLeafActive
} from './mobile-session-layout-projection'

export function buildHeadlessMobileSessionTerminalTabs(
  worktreeId: string,
  persistedTabs: readonly TerminalTab[],
  session: WorkspaceSessionState
): RuntimeMobileSessionTerminalTab[] {
  const unifiedTabs = session.unifiedTabs?.[worktreeId]
  return [...persistedTabs]
    .sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt - b.createdAt)
    .flatMap((tab, index) => {
      const layout = session.terminalLayoutsByTabId?.[tab.id]
      const leafIds = collectPersistedTerminalLeafIds(layout)
      // Why: a legacy tab with no layout has one derived pane, which owns the tab-wide launch hint.
      const launchAgentLeafId =
        leafIds.length === 0
          ? deriveHeadlessLegacyTerminalLeafId(tab.id)
          : isNativeChatTabWideFallbackSafe(layout)
            ? resolveNativeChatActiveLayoutLeafId(layout)
            : null
      if (leafIds.length === 0) {
        leafIds.push(deriveHeadlessLegacyTerminalLeafId(tab.id))
      }
      const chatPair = normalizeTerminalChatPair(
        {
          viewMode: resolveTerminalTabViewMode(
            unifiedTabs?.find(
              (unified) => unified.contentType === 'terminal' && unified.entityId === tab.id
            ),
            tab
          ),
          ...(layout?.chatLeafId ? { chatLeafId: layout.chatLeafId } : {})
        },
        layout?.root
      )
      const parentLayout = layout ? cloneTerminalLayoutSnapshot(layout) : undefined
      if (parentLayout && parentLayout.chatLeafId !== chatPair.chatLeafId) {
        delete parentLayout.chatLeafId
      }
      return leafIds.flatMap((leafId) => {
        const launchAgent = nativeChatLaunchAgentForLeaf({
          launchAgent: tab.launchAgent,
          launchAgentLeafId,
          leafId,
          leafIds
        })
        const ptyId = layout?.ptyIdsByLeafId?.[leafId] ?? (leafIds.length === 1 ? tab.ptyId : null)
        const title =
          tab.customTitle?.trim() ||
          tab.generatedTitle?.trim() ||
          tab.title?.trim() ||
          tab.defaultTitle?.trim() ||
          `Terminal ${index + 1}`
        return [
          {
            type: 'terminal' as const,
            id: `${tab.id}::${leafId}`,
            parentTabId: tab.id,
            leafId,
            title,
            ...(ptyId ? { ptyId } : {}),
            ...(tab.startupCwd ? { startupCwd: tab.startupCwd } : {}),
            ...(launchAgent ? { launchAgent } : {}),
            ...(parentLayout ? { parentLayout: cloneTerminalLayoutSnapshot(parentLayout) } : {}),
            ...(tab.color != null ? { color: tab.color } : {}),
            ...(tab.isPinned ? { isPinned: true } : {}),
            ...(chatPair.viewMode ? { viewMode: chatPair.viewMode } : {}),
            isActive: isPersistedTerminalLeafActive(session, worktreeId, tab.id, leafId, layout)
          }
        ]
      })
    })
}
