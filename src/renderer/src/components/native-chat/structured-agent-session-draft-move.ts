// A structured chat's draft belongs to its conversation. A /clear moves the chat to a new
// conversation, so the unsent draft moves with it rather than staying in one nothing shows.

import { appendNativeChatDraftCache } from './native-chat-draft-cache'
import {
  appendToNativeChatComposerDraft,
  hydrateNativeChatComposerDrafts,
  isNativeChatComposerDraftLoadPending,
  readNativeChatComposerDraft,
  structuredAgentSessionDraftScopeKey,
  updateNativeChatComposerDraft
} from './native-chat-composer-draft-store'
import { nativeChatComposerDraftLeftAfterSend } from './native-chat-composer-draft-comparison'
import type { NativeChatComposerDraft } from './native-chat-composer-draft-storage'
import type { Tab } from '../../../../shared/tab-types'

// In memory: a send's text stays in the box until its host accepts it, and the chat can move first.
const sendsOut = new Map<string, NativeChatComposerDraft>()

/** Marks what a send in flight takes out of the box once accepted; a move leaves that behind for
 *  the send to clear. Returns the release, for when the send settles. */
export function noteNativeChatDraftSendOut(
  scopeKey: string,
  submitted: NativeChatComposerDraft
): () => void {
  sendsOut.set(scopeKey, submitted)
  return () => {
    if (sendsOut.get(scopeKey) === submitted) {
      sendsOut.delete(scopeKey)
    }
  }
}

/** Moves a conversation's draft into the one its chat moved to, after whatever that one holds. */
export function moveStructuredAgentSessionDraft(fromSessionId: string, toSessionId: string): void {
  if (isNativeChatComposerDraftLoadPending()) {
    // Why: until the saved drafts load, the old conversation's draft may not be in memory yet.
    void hydrateNativeChatComposerDrafts().then(() =>
      moveStructuredAgentSessionDraft(fromSessionId, toSessionId)
    )
    return
  }
  const from = structuredAgentSessionDraftScopeKey(fromSessionId)
  const to = structuredAgentSessionDraftScopeKey(toSessionId)
  const current = readNativeChatComposerDraft(from)
  const out = sendsOut.get(from)
  // Null once edited inside the sent text: none of it is the send's alone any more, so all moves.
  const left = out ? nativeChatComposerDraftLeftAfterSend(current, out) : null
  const moving = left ?? current
  if (moving.text.trim() === '' && moving.images.length === 0) {
    return
  }
  let durable = appendNativeChatDraftCache(to, moving.text)
  if (moving.images.length > 0) {
    durable = appendToNativeChatComposerDraft(to, { images: moving.images }) && durable
  }
  // Skill chips live in the document, which only holds for exactly this text.
  if (!left && current.document && readNativeChatComposerDraft(to).text === current.text) {
    updateNativeChatComposerDraft(to, { document: current.document }, 'deferred')
  }
  if (!durable) {
    // Why: a copy in both beats losing it, should the app quit before the new one is saved.
    return
  }
  const kept =
    out && left
      ? { text: out.text, images: current.images.filter((image) => !left.images.includes(image)) }
      : { text: '', images: [] }
  updateNativeChatComposerDraft(from, { ...kept, document: undefined }, 'immediate')
}

/** Each chat whose tab now shows another conversation: a /clear's, whichever client ran it. */
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

export function resetStructuredAgentSessionDraftMoveForTests(): void {
  sendsOut.clear()
}
