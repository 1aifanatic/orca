// A /clear replaces a chat with a new conversation and moves its tab there; the host publishes
// which conversation the tab's replaced (`replacesSessionId`). Whatever this window still held for
// the old one — the composer's draft, and messages that never reached it — belongs where the user
// now is. Derived from that link whenever the new chat renders, so it holds for a pane that was
// never mounted, after a reload, or for a tab that was not active when the clear ran.

import { useCallback, useEffect, useSyncExternalStore } from 'react'
import { isLoneStructuredAgentSessionConversationCommand } from '../../../../shared/structured-agent-session-composer'
import { structuredAgentSessionEntryRejectedByHost } from '../../../../shared/structured-agent-session-outbox'
import type { StructuredAgentSessionOutboxEntry } from '../../../../shared/structured-agent-session-outbox'
import {
  appendToNativeChatComposerDraft,
  deleteNativeChatComposerDraft,
  readNativeChatComposerDraft,
  structuredAgentSessionDraftScopeKey
} from './native-chat-composer-draft-store'
import { readMountedStructuredAgentSessionOutbox } from './structured-agent-session-outbox-dispatch'
import {
  commitStructuredAgentSessionOutbox,
  getStructuredAgentSessionOutbox,
  loadStructuredAgentSessionOutbox,
  readOutbox,
  subscribeToStructuredAgentSessionOutbox
} from './structured-agent-session-outbox-storage'
import { useStructuredAgentSessionWithdrawnRestore } from './structured-agent-session-withdrawn-message-restore'

const NO_ENTRIES: readonly StructuredAgentSessionOutboxEntry[] = []
const NO_SUBSCRIPTION = (): void => {}

/** The old conversation's draft goes after anything already here. A lone command is the /clear
 *  that replaced it (or one spent with it), which the new chat must never start with. */
function carryDraft(fromSessionId: string, composerScopeKey: string): void {
  const from = structuredAgentSessionDraftScopeKey(fromSessionId)
  const draft = readNativeChatComposerDraft(from)
  if (draft.text === '' && draft.images.length === 0) {
    return
  }
  const command = isLoneStructuredAgentSessionConversationCommand(draft.text.trim())
  if (
    (command && draft.images.length === 0) ||
    appendToNativeChatComposerDraft(composerScopeKey, { text: draft.text, images: draft.images })
  ) {
    deleteNativeChatComposerDraft(from)
  }
}

export function useStructuredAgentSessionReplacementCarry(args: {
  replacesSessionId: string | undefined
  composerScopeKey: string | undefined
  /** The new chat's state is loaded: its host-held cards are known. */
  ready: boolean
  /** Ids of the new chat's cards: a message the host carried as one is already here. */
  queuedMessageIds: readonly string[] | undefined
  /** Says once, on this composer's line, why text came back. */
  say: (notice: string) => void
  notice: string
}): void {
  const { composerScopeKey, notice, queuedMessageIds, ready, replacesSessionId, say } = args
  // A send still marked on its way had its pane unmounted under it: read as in doubt, as a pane
  // mounting on its own chat reads it.
  const load = useCallback(
    () =>
      replacesSessionId
        ? readMountedStructuredAgentSessionOutbox(replacesSessionId, null, readOutbox)
        : [],
    [replacesSessionId]
  )
  const subscribe = useCallback(
    (listener: () => void) =>
      replacesSessionId
        ? subscribeToStructuredAgentSessionOutbox(replacesSessionId, load, listener)
        : NO_SUBSCRIPTION,
    [load, replacesSessionId]
  )
  const leftovers = useSyncExternalStore(subscribe, () =>
    replacesSessionId ? loadStructuredAgentSessionOutbox(replacesSessionId, load) : NO_ENTRIES
  )
  const fromSessionId = replacesSessionId ?? ''
  const restore = useStructuredAgentSessionWithdrawnRestore(fromSessionId, composerScopeKey)

  useEffect(() => {
    if (replacesSessionId && composerScopeKey) {
      carryDraft(replacesSessionId, composerScopeKey)
    }
  }, [composerScopeKey, replacesSessionId])

  useEffect(() => {
    if (!replacesSessionId || !composerScopeKey || !ready || leftovers.length === 0) {
      return
    }
    const carriedAsCards = new Set(queuedMessageIds)
    // Never resent into the cleared chat. One the host recorded and rejected is its row there; one
    // the host carried as a card is that card here; the rest never reached it, so their text does.
    const handedBack = leftovers.filter(
      (entry) =>
        !structuredAgentSessionEntryRejectedByHost(entry) &&
        !carriedAsCards.has(entry.clientMessageId)
    )
    restore.byStop(handedBack)
    commitStructuredAgentSessionOutbox(
      replacesSessionId,
      getStructuredAgentSessionOutbox(replacesSessionId).filter(
        (entry) => !leftovers.some((left) => left.clientMessageId === entry.clientMessageId)
      )
    )
    if (handedBack.length > 0) {
      say(notice)
    }
  }, [
    composerScopeKey,
    leftovers,
    notice,
    queuedMessageIds,
    ready,
    replacesSessionId,
    restore,
    say
  ])
}
