// Why a send's text came back to the composer, said once on the line above the composer that holds
// it. The answer can land after a /clear moved the pane to the new conversation, so the words
// follow the text there; a pane not mounted yet reads them when it mounts.

import { useEffect } from 'react'
import { currentNativeChatComposerDraftScope } from './native-chat-composer-draft-forwarding'

const pending = new Map<string, string>()
const listeners = new Map<string, Set<(notice: string) => void>>()

export function noteStructuredAgentSessionHandedBackSend(
  paneScopeKey: string | undefined,
  notice: string
): void {
  if (!paneScopeKey) {
    return
  }
  const scopeKey = currentNativeChatComposerDraftScope(paneScopeKey)
  const shown = listeners.get(scopeKey)
  if (shown && shown.size > 0) {
    shown.forEach((listener) => listener(notice))
    return
  }
  pending.set(scopeKey, notice)
}

/** Shows the notice on this composer's line, once: taken from `pending` when it mounts. */
export function useStructuredAgentSessionHandedBackNotice(
  composerScopeKey: string | undefined,
  show: (notice: string) => void
): void {
  useEffect(() => {
    if (!composerScopeKey) {
      return undefined
    }
    const waiting = pending.get(composerScopeKey)
    if (waiting !== undefined) {
      pending.delete(composerScopeKey)
      show(waiting)
    }
    const set = listeners.get(composerScopeKey) ?? new Set()
    listeners.set(composerScopeKey, set)
    set.add(show)
    return () => {
      set.delete(show)
      if (set.size === 0 && listeners.get(composerScopeKey) === set) {
        listeners.delete(composerScopeKey)
      }
    }
  }, [composerScopeKey, show])
}

export function clearStructuredAgentSessionHandedBackNoticesForTests(): void {
  pending.clear()
  listeners.clear()
}
