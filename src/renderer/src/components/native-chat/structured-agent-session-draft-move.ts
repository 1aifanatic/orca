// A structured chat's draft belongs to its conversation. A /clear moves the chat to a new
// conversation, so the unsent draft moves with it rather than staying in one nothing shows.

import { withNativeChatComposerDraftAddition } from './native-chat-composer-draft-addition'
import {
  clearNativeChatComposerDraftIfUnchanged,
  nativeChatComposerDraftWriteSettled,
  hydrateNativeChatComposerDrafts,
  isNativeChatComposerDraftLoadPending,
  isNativeChatComposerDraftUnverified,
  markNativeChatComposerDraftUnverified,
  readNativeChatComposerDraft,
  structuredAgentSessionDraftScopeKey,
  updateNativeChatComposerDraft
} from './native-chat-composer-draft-store'
import { sameNativeChatComposerDraftDocument } from './native-chat-composer-draft-comparison'
import { moveNativeChatPendingAttachments } from './native-chat-pending-attachment-cache'
import { mergeNativeChatDraftDocument } from './native-chat-draft-document-merge'
import type { Tab } from '../../../../shared/tab-types'

/** Moves the whole draft, removing its source only after the destination is saved. */
export async function moveStructuredAgentSessionDraft(
  fromSessionId: string,
  toSessionId: string
): Promise<void> {
  if (fromSessionId === toSessionId) {
    return
  }
  const from = structuredAgentSessionDraftScopeKey(fromSessionId)
  const to = structuredAgentSessionDraftScopeKey(toSessionId)
  moveNativeChatPendingAttachments(from, to)
  if (isNativeChatComposerDraftLoadPending()) {
    await hydrateNativeChatComposerDrafts()
    if (isNativeChatComposerDraftLoadPending()) {
      return
    }
  }
  const source = readNativeChatComposerDraft(from)
  if (source.text === '' && source.images.length === 0) {
    return
  }
  const target = readNativeChatComposerDraft(to)
  const merged = withNativeChatComposerDraftAddition(target, { text: source.text })
  const emptyTarget = target.text === '' && target.images.length === 0
  updateNativeChatComposerDraft(
    to,
    {
      ...(emptyTarget ? source : merged),
      images: emptyTarget
        ? source.images
        : [
            ...target.images,
            ...source.images.filter((image) => !target.images.some((held) => held.id === image.id))
          ],
      document: mergeNativeChatDraftDocument(target, source, merged.text)
    },
    'immediate'
  )
  if (source.images.length > 0 && isNativeChatComposerDraftUnverified(from)) {
    markNativeChatComposerDraftUnverified(to)
  }
  if (
    (await nativeChatComposerDraftWriteSettled(to)) &&
    sameNativeChatComposerDraftDocument(readNativeChatComposerDraft(from).document, source.document)
  ) {
    clearNativeChatComposerDraftIfUnchanged(from, source)
  }
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
