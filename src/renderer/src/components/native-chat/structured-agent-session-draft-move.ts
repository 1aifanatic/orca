// Unsent input follows its chat tab when /clear changes that tab's conversation.

import { withNativeChatComposerDraftAddition } from './native-chat-composer-draft-addition'
import {
  clearNativeChatComposerDraftIfUnchanged,
  nativeChatComposerDraftWriteSettled,
  hydrateNativeChatComposerDrafts,
  isNativeChatComposerDraftLoadPending,
  markNativeChatComposerDraftUnverified,
  readNativeChatComposerDraft,
  structuredAgentSessionDraftScopeKey,
  updateNativeChatComposerDraft
} from './native-chat-composer-draft-store'
import { sameNativeChatComposerDraftDocument } from './native-chat-composer-draft-comparison'
import { moveNativeChatPendingAttachments } from './native-chat-pending-attachment-cache'
import { mergeNativeChatDraftDocument } from './native-chat-draft-document-merge'
import {
  captureNativeChatDraftTransfer,
  nativeChatDraftTransferSourceUnchanged,
  type NativeChatDraftTransferSnapshot
} from './native-chat-draft-transfer-snapshot'
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
  const captured = await captureNativeChatDraftTransfer(from)
  if (isNativeChatComposerDraftLoadPending()) {
    await hydrateNativeChatComposerDrafts()
    if (isNativeChatComposerDraftLoadPending()) {
      return
    }
  }
  await moveCapturedStructuredAgentSessionDraft(fromSessionId, toSessionId, captured)
}

/** Pending operations already moved at the switch; later history operations stay where begun. */
export async function moveCapturedStructuredAgentSessionDraft(
  fromSessionId: string,
  toSessionId: string,
  snapshot: NativeChatDraftTransferSnapshot
): Promise<void> {
  if (fromSessionId === toSessionId) {
    return
  }
  const from = structuredAgentSessionDraftScopeKey(fromSessionId)
  const to = structuredAgentSessionDraftScopeKey(toSessionId)
  const source = snapshot.draft
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
  if (source.images.length > 0 && snapshot.unverified) {
    markNativeChatComposerDraftUnverified(to)
  }
  if (
    (await nativeChatComposerDraftWriteSettled(to)) &&
    nativeChatDraftTransferSourceUnchanged(from, snapshot) &&
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
