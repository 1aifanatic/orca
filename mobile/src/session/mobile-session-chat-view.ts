import {
  isNativeChatSupportedAgent,
  nativeChatRequiresLocalTranscript
} from '../../../src/shared/native-chat-agent-support'
import type { TerminalChatPair } from '../../../src/shared/terminal-tab-view-mode'
import type { MobileSessionView } from '../storage/session-view-preferences'
import type { MobileSessionParentLayout } from './mobile-session-route-types'
import { terminalLayoutLeafIds } from './mobile-terminal-records'

/** One leaf's view on a host that owns the chat pair; `undecided` waits on a settling input. */
export type MobileLeafView = 'chat' | 'terminal' | 'undecided'

export type MobileNativeChatReadability = 'unknown' | 'readable' | 'unreadable' | 'failed'

export type MobileChatViewRow = {
  type: string
  id: string
  parentTabId?: string
  leafId?: string
  launchAgent?: string | null
  viewMode?: 'terminal' | 'chat'
  parentLayout?: MobileSessionParentLayout
  ptyId?: string | null
  incarnationId?: string | null
}

export type MobileChatViewInputs = {
  defaultView: { value: MobileSessionView; settled: boolean }
  readability: MobileNativeChatReadability
}

export function chatViewParentTabId(row: MobileChatViewRow): string {
  return row.parentTabId ?? row.id
}

export function chatViewLeafId(row: MobileChatViewRow): string {
  return row.leafId ?? row.id
}

/** Fences retained identity and pending writes to one PTY; main publishes no incarnation yet. */
export function chatViewIdentityFence(row: MobileChatViewRow): string {
  return row.incarnationId ?? row.ptyId ?? ''
}

/** The parent's leaves: the published tree, else the sibling rows the snapshot carries. */
export function chatViewLeafIds(
  row: MobileChatViewRow,
  rows: readonly MobileChatViewRow[]
): string[] {
  const root = row.parentLayout?.root
  if (root) {
    return terminalLayoutLeafIds(root)
  }
  const parent = chatViewParentTabId(row)
  return rows
    .filter(
      (candidate) => candidate.type === 'terminal' && chatViewParentTabId(candidate) === parent
    )
    .map(chatViewLeafId)
}

export function hostChatPairForRow(row: MobileChatViewRow): TerminalChatPair {
  const chatLeafId = row.parentLayout?.chatLeafId
  return {
    ...(row.viewMode ? { viewMode: row.viewMode } : {}),
    ...(chatLeafId ? { chatLeafId } : {})
  }
}

/**
 * The view of one terminal leaf. `pair` is the pending click, else the accepted host pair.
 * Live agent status is deliberately not an input: it only decides whether chat is offered.
 */
export function resolveMobileLeafView(
  row: MobileChatViewRow,
  pair: TerminalChatPair,
  leafIds: readonly string[],
  inputs: MobileChatViewInputs
): MobileLeafView {
  const leafId = chatViewLeafId(row)
  // Why first: an owner outside the tree means its pane closed, so no sibling may claim chat.
  if (pair.chatLeafId && !leafIds.includes(pair.chatLeafId)) {
    return 'terminal'
  }
  if (pair.viewMode === 'chat') {
    // Why display-only: an ownerless host chat shows on the sole or active leaf and is never claimed.
    const owner =
      pair.chatLeafId ??
      (leafIds.length === 1 ? leafIds[0] : (row.parentLayout?.activeLeafId ?? null))
    return owner === leafId && leafIds.includes(owner) ? 'chat' : 'terminal'
  }
  if (pair.viewMode === 'terminal') {
    return 'terminal'
  }
  // Nobody switched this tab: this device's default, for a sole leaf launched as a supported agent.
  if (leafIds.length !== 1 || leafIds[0] !== leafId) {
    return 'terminal'
  }
  const agent = row.launchAgent ?? null
  if (!agent || !isNativeChatSupportedAgent(agent)) {
    return 'terminal'
  }
  if (!inputs.defaultView.settled) {
    return 'undecided'
  }
  if (inputs.defaultView.value !== 'chat') {
    return 'terminal'
  }
  if (nativeChatRequiresLocalTranscript(agent)) {
    switch (inputs.readability) {
      case 'readable':
        return 'chat'
      case 'unknown':
        return 'undecided'
      default:
        return 'terminal'
    }
  }
  return 'chat'
}

/** The absolute pair a switch on `row` asks the host for, given the pair the user sees. */
export function chatPairToggleTarget(
  row: MobileChatViewRow,
  pair: TerminalChatPair,
  leafIds: readonly string[],
  inputs: MobileChatViewInputs
): TerminalChatPair {
  return resolveMobileLeafView(row, pair, leafIds, inputs) === 'chat'
    ? { viewMode: 'terminal' }
    : { viewMode: 'chat', chatLeafId: chatViewLeafId(row) }
}
