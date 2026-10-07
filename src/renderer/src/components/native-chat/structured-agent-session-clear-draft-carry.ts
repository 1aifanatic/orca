// A /clear moves a chat to a new conversation, and its box then shows that conversation's draft.
// What was left in the old one's draft goes with it, so nothing typed during the clear is stranded
// in a conversation the chat no longer shows.

import { appendNativeChatDraftCache } from './native-chat-draft-cache'
import {
  appendToNativeChatComposerDraft,
  readNativeChatComposerDraft,
  structuredAgentSessionDraftScopeKey,
  structuredAgentSessionIdOfDraftScope,
  updateNativeChatComposerDraft
} from './native-chat-composer-draft-store'

// In memory: only a /clear this window ran moves a draft, and a view leaving that conversation
// consumes the entry.
const clearedInto = new Map<string, string>()

export function noteStructuredAgentSessionClearedInto(
  sessionId: string,
  replacementSessionId: string
): void {
  clearedInto.set(sessionId, replacementSessionId)
}

/** Moves a cleared conversation's draft into the one it went on in, after whatever that holds.
 *  `leaving`: the chat's view moved on, so nothing more can land in the old draft. */
export function carryClearedStructuredAgentSessionDraft(
  sessionId: string,
  options: { leaving?: boolean } = {}
): void {
  const replacement = clearedInto.get(sessionId)
  if (options.leaving) {
    clearedInto.delete(sessionId)
  }
  if (replacement === undefined) {
    return
  }
  const from = structuredAgentSessionDraftScopeKey(sessionId)
  const draft = readNativeChatComposerDraft(from)
  if (draft.text === '' && draft.images.length === 0) {
    return
  }
  const to = structuredAgentSessionDraftScopeKey(replacement)
  appendNativeChatDraftCache(to, draft.text)
  if (draft.images.length > 0) {
    appendToNativeChatComposerDraft(to, { images: draft.images })
  }
  updateNativeChatComposerDraft(from, { text: '', images: [] }, 'immediate')
}

/** The composer's side: once a command it sent settles, what is left of its draft follows a
 *  /clear that moved the chat. */
export function carryClearedNativeChatDraftScope(scopeKey: string): void {
  const sessionId = structuredAgentSessionIdOfDraftScope(scopeKey)
  if (sessionId !== null) {
    carryClearedStructuredAgentSessionDraft(sessionId)
  }
}

export function resetStructuredAgentSessionClearCarryForTests(): void {
  clearedInto.clear()
}
