// Every stored or answered tab snapshot re-applies the /clear replacements, and deriving them walks
// every record. A listing stores and answers once per tab and per worktree, so inside one listing
// they are derived once and shared; everywhere else each call derives them fresh.

import { AsyncLocalStorage } from 'node:async_hooks'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import type { ConversationReplacement } from '../native-chat/agent-session-wire/structured-conversation-command'

type ListingScope = { replacements?: readonly ConversationReplacement[]; ended: boolean }

const listingScope = new AsyncLocalStorage<ListingScope>()

/** Runs one listing request with its replacements derived at most once. */
export async function withListingConversationReplacements<T>(run: () => Promise<T>): Promise<T> {
  const scope: ListingScope = { ended: false }
  try {
    return await listingScope.run(scope, run)
  } finally {
    // A timer or task the listing started outlives it and must derive fresh.
    scope.ended = true
  }
}

export function currentConversationReplacements(): readonly ConversationReplacement[] {
  const scope = listingScope.getStore()
  const host = getStructuredAgentSessionHost()
  if (!scope || scope.ended) {
    return host?.conversationReplacements?.() ?? []
  }
  // Only a host's answer is kept: before the listing installs one there is nothing to derive yet.
  scope.replacements ??= host?.conversationReplacements?.()
  return scope.replacements ?? []
}
