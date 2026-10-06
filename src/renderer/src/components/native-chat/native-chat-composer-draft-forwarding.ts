// A /clear moves a chat's tab to the conversation that replaces it. The composer there is keyed by
// that conversation, so what was typed, or is handed back later, under the old one follows it.

import {
  appendToNativeChatComposerDraft,
  deleteNativeChatComposerDraft,
  readNativeChatComposerDraft,
  structuredAgentSessionDraftScopeKey
} from './native-chat-composer-draft-store'

// In memory: only a pane still mounted on the old conversation hands text back to it.
const forwardedScopes = new Map<string, string>()

/** The draft scope text for `scopeKey` belongs in now: the conversation that replaced it, if any. */
export function currentNativeChatComposerDraftScope(scopeKey: string): string {
  const seen = new Set<string>()
  let current = scopeKey
  while (forwardedScopes.has(current) && !seen.has(current)) {
    seen.add(current)
    current = forwardedScopes.get(current)!
  }
  return current
}

/** The pane moved from one conversation to the one replacing it: its draft goes along, after
 *  anything already there, and later hand-backs to the old one land in the new one. */
export function forwardStructuredAgentSessionDraft(
  fromSessionId: string,
  toSessionId: string
): void {
  const from = structuredAgentSessionDraftScopeKey(fromSessionId)
  const to = structuredAgentSessionDraftScopeKey(toSessionId)
  if (from === to || currentNativeChatComposerDraftScope(to) === from) {
    return
  }
  forwardedScopes.set(from, to)
  const draft = readNativeChatComposerDraft(from)
  if (draft.text === '' && draft.images.length === 0) {
    return
  }
  // The copy goes only once the new one is durable.
  if (appendToNativeChatComposerDraft(to, { text: draft.text, images: draft.images })) {
    deleteNativeChatComposerDraft(from)
  }
}

export function clearNativeChatComposerDraftForwardingForTests(): void {
  forwardedScopes.clear()
}
