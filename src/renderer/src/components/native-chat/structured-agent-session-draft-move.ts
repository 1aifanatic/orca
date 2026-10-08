// Unsent input follows its chat tab when /clear changes that tab's conversation.

import {
  isNativeChatComposerDraftHydrated,
  moveNativeChatComposerDraft,
  readNativeChatComposerDraft,
  structuredAgentSessionDraftScopeKey
} from './native-chat-composer-draft-store'
import {
  moveNativeChatPendingAttachments,
  nativeChatPendingAttachmentSnapshot
} from './native-chat-pending-attachment-cache'
import type { Tab } from '../../../../shared/tab-types'

/** Moves loaded input into an empty replacement; conflicting input stays in history. */
export function moveStructuredAgentSessionDraft(fromSessionId: string, toSessionId: string): void {
  if (fromSessionId === toSessionId || !isNativeChatComposerDraftHydrated()) {
    return
  }
  const from = structuredAgentSessionDraftScopeKey(fromSessionId)
  const to = structuredAgentSessionDraftScopeKey(toSessionId)
  const target = readNativeChatComposerDraft(to)
  if (
    target.text !== '' ||
    target.images.length > 0 ||
    nativeChatPendingAttachmentSnapshot(to).length > 0
  ) {
    return
  }
  moveNativeChatPendingAttachments(from, to)
  moveNativeChatComposerDraft(from, to)
}

/** Each chat whose tab now shows another conversation, whichever client ran the clear. */
export function structuredAgentSessionConversationMoves(
  previous: Readonly<Record<string, readonly Tab[]>>,
  next: Readonly<Record<string, readonly Tab[]>>
): { from: string; to: string }[] {
  const moves: { from: string; to: string }[] = []
  for (const [worktreeId, tabs] of Object.entries(next)) {
    const before = previous[worktreeId]
    if (!before || before === tabs) {
      continue
    }
    const shown = new Map(
      before.flatMap((tab) => (tab.contentType === 'agent-session' ? [[tab.id, tab.entityId]] : []))
    )
    for (const tab of tabs) {
      const was = tab.contentType === 'agent-session' ? shown.get(tab.id) : undefined
      if (was !== undefined && was !== tab.entityId) {
        moves.push({ from: was, to: tab.entityId })
      }
    }
  }
  return moves
}
