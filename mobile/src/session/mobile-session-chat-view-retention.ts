import type { TerminalChatPair } from '../../../src/shared/terminal-tab-view-mode'
import {
  resolveMobileNativeChat,
  type MobileNativeChatResolution,
  type MobileNativeChatTab
} from './mobile-native-chat-eligibility'
import {
  advanceChatViewProcessFence,
  chatViewLeafId,
  chatViewLeafIds,
  chatViewParentTabId,
  ownerlessChatDisplayLeaf,
  type ChatViewProcessFence,
  type MobileChatViewRow
} from './mobile-session-chat-view'

export type RetainedChatViewRow = {
  fence: ChatViewProcessFence
  identity: MobileNativeChatResolution | null
}

/** What one session route remembers between accepted snapshots of its host and worktree. */
export type ChatViewRetention = {
  /** Per row: the last transcript identity seen behind its current terminal process. */
  rows: ReadonlyMap<string, RetainedChatViewRow>
  /** Rows whose terminal process changed since the previous snapshot. */
  processChanged: ReadonlySet<string>
  /** Parent tab id -> the leaf its ownerless chat shows on. */
  ownerlessChatLeaves: ReadonlyMap<string, string>
}

export const EMPTY_CHAT_VIEW_RETENTION: ChatViewRetention = {
  rows: new Map(),
  processChanged: new Set(),
  ownerlessChatLeaves: new Map()
}

/** Keeps the last identity through a status lapse, and a session id the next status omits. */
function retainIdentity(
  previous: MobileNativeChatResolution | null,
  current: MobileNativeChatResolution | null
): MobileNativeChatResolution | null {
  if (!current) {
    return previous
  }
  if (previous && previous.agent === current.agent && !current.sessionId && previous.sessionId) {
    return {
      ...current,
      sessionId: previous.sessionId,
      transcriptPath: current.transcriptPath ?? previous.transcriptPath
    }
  }
  return current
}

/**
 * Re-derives the retention from the previous one and the latest rows. Entries die with their row,
 * on a new terminal process, or (ownerless chat) once the pair stops being an ownerless chat.
 */
export function advanceChatViewRetention(
  previous: ChatViewRetention,
  args: {
    rows: readonly (MobileChatViewRow & MobileNativeChatTab)[]
    readable: boolean
    pairFor: (row: MobileChatViewRow) => TerminalChatPair
  }
): ChatViewRetention {
  const rows = new Map<string, RetainedChatViewRow>()
  const processChanged = new Set<string>()
  const rowIdByLeaf = new Map<string, string>()
  for (const row of args.rows) {
    const before = previous.rows.get(row.id)
    const { fence, changed } = advanceChatViewProcessFence(before?.fence, row)
    if (changed) {
      processChanged.add(row.id)
    }
    const kept = changed ? null : (before?.identity ?? null)
    rows.set(row.id, {
      fence,
      identity: retainIdentity(kept, resolveMobileNativeChat(row, args.readable))
    })
    rowIdByLeaf.set(`${chatViewParentTabId(row)}\0${chatViewLeafId(row)}`, row.id)
  }
  const ownerlessChatLeaves = new Map<string, string>()
  const seenParents = new Set<string>()
  for (const row of args.rows) {
    const parent = chatViewParentTabId(row)
    if (seenParents.has(parent)) {
      continue
    }
    seenParents.add(parent)
    const pair = args.pairFor(row)
    if (pair.viewMode !== 'chat' || pair.chatLeafId) {
      continue
    }
    const leaf = ownerlessChatDisplayLeaf({
      shown: previous.ownerlessChatLeaves.get(parent) ?? null,
      leafIds: chatViewLeafIds(row, args.rows),
      activeLeafId: row.parentLayout?.activeLeafId,
      canShowChat: (leafId) => {
        const rowId = rowIdByLeaf.get(`${parent}\0${leafId}`)
        return rowId !== undefined && rows.get(rowId)?.identity != null
      }
    })
    if (leaf) {
      ownerlessChatLeaves.set(parent, leaf)
    }
  }
  return { rows, processChanged, ownerlessChatLeaves }
}
