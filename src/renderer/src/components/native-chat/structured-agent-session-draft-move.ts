// Unsent input follows its chat tab when /clear changes that tab's conversation.

import { withNativeChatComposerDraftAddition } from './native-chat-composer-draft-addition'
import {
  isNativeChatComposerDraftHydrated,
  moveNativeChatComposerDraft,
  structuredAgentSessionDraftScopeKey
} from './native-chat-composer-draft-store'
import { moveNativeChatPendingAttachments } from './native-chat-pending-attachment-cache'
import { mergeNativeChatDraftDocument } from './native-chat-draft-document-merge'
import type { Tab } from '../../../../shared/tab-types'

/** Moves the loaded draft synchronously with its tab; unobserved input stays in history. */
export function moveStructuredAgentSessionDraft(fromSessionId: string, toSessionId: string): void {
  if (fromSessionId === toSessionId || !isNativeChatComposerDraftHydrated()) {
    return
  }
  const from = structuredAgentSessionDraftScopeKey(fromSessionId)
  const to = structuredAgentSessionDraftScopeKey(toSessionId)
  moveNativeChatPendingAttachments(from, to)
  moveNativeChatComposerDraft(from, to, (target, source) => {
    const merged = withNativeChatComposerDraftAddition(target, { text: source.text })
    const emptyTarget = target.text === '' && target.images.length === 0
    return {
      ...(emptyTarget ? source : merged),
      images: emptyTarget
        ? source.images
        : [
            ...target.images,
            ...source.images.filter((image) => !target.images.some((held) => held.id === image.id))
          ],
      document: mergeNativeChatDraftDocument(target, source, merged.text)
    }
  })
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
