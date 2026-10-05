import type { AppState } from '../../types'
import { terminalLayoutNodeLeafIds } from '../../../../../shared/native-chat-leaf-ownership'
import { locateTerminalTab } from '../../terminals/terminal-tab-location'
import { readTerminalChatPair } from './terminal-chat-pair-state'

type ExitRetirementState = Pick<
  AppState,
  'tabsByWorktree' | 'unifiedTabsByWorktree' | 'terminalLayoutsByTabId'
>

/**
 * What a host-proven agent exit in `leafId` may change, decided on this store's current state:
 * chat turns terminal only while that pane still owns it, and nothing changes once the pane is
 * bound to another PTY (a newer user switch or a respawn wins over the stale exit).
 */
export function resolveExitedAgentChatRetirement(
  state: ExitRetirementState,
  terminalTabId: string,
  leafId: string,
  ptyId: string
): { retireChat: boolean; clearLaunchAgent: boolean } | null {
  const pair = readTerminalChatPair(state, terminalTabId)
  if (!pair) {
    return null
  }
  const layout = state.terminalLayoutsByTabId[terminalTabId]
  const leafIds = terminalLayoutNodeLeafIds(layout?.root)
  const soleLeaf = leafIds.length <= 1
  const boundPtyId =
    layout?.ptyIdsByLeafId?.[leafId] ??
    (soleLeaf ? locateTerminalTab(state.tabsByWorktree, terminalTabId)?.tab.ptyId : undefined)
  if (boundPtyId && boundPtyId !== ptyId) {
    return null
  }
  if (leafIds.length > 0 && !leafIds.includes(leafId)) {
    return null
  }
  const ownsChat =
    pair.viewMode === 'chat' && (pair.chatLeafId ? pair.chatLeafId === leafId : soleLeaf)
  return { retireChat: ownsChat, clearLaunchAgent: soleLeaf }
}
