// Each pane's dismissed prompt occurrence, kept outside the view so a remount cannot reshow it.
// Dies when the pane observes its prompt clear or change, its tab retires, or by the bound.
import { setBoundedScopeCacheEntry } from './native-chat-composer-scope-cache'

export type NativeChatPromptDismissal = Readonly<{
  /** The card's content key. */
  content: string
  /** The host wait's start for a status-backed prompt; null for a transcript-only one. */
  startedAt: number | null
  /** Answered: the card is gone. Collapsed: the user folded it to a strip above the composer. */
  state: 'answered' | 'collapsed'
}>

const dismissalsByPaneKey = new Map<string, NativeChatPromptDismissal>()
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) {
    listener()
  }
}

export function subscribeNativeChatPromptDismissals(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function readNativeChatPromptDismissal(paneKey: string): NativeChatPromptDismissal | null {
  return dismissalsByPaneKey.get(paneKey) ?? null
}

export function recordNativeChatPromptDismissal(
  paneKey: string,
  dismissal: NativeChatPromptDismissal
): void {
  setBoundedScopeCacheEntry(dismissalsByPaneKey, paneKey, dismissal)
  notify()
}

export function forgetNativeChatPromptDismissal(paneKey: string): void {
  if (dismissalsByPaneKey.delete(paneKey)) {
    notify()
  }
}

export function forgetNativeChatPromptDismissalsForTab(tabId: string): void {
  const prefix = `${tabId}:`
  let changed = false
  for (const paneKey of dismissalsByPaneKey.keys()) {
    if (paneKey.startsWith(prefix)) {
      dismissalsByPaneKey.delete(paneKey)
      changed = true
    }
  }
  if (changed) {
    notify()
  }
}

export function clearNativeChatPromptDismissalsForTests(): void {
  dismissalsByPaneKey.clear()
}
