// The prompt occurrence each pane answered from chat, kept outside the view so a remount cannot
// reshow it. Dies when the pane observes its prompt clear or change, its tab retires, or by the bound.
import { setBoundedScopeCacheEntry } from './native-chat-composer-scope-cache'

const answeredByPaneKey = new Map<string, string>()
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) {
    listener()
  }
}

export function subscribeAnsweredNativeChatPrompts(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function readAnsweredNativeChatPrompt(paneKey: string): string | null {
  return answeredByPaneKey.get(paneKey) ?? null
}

export function recordAnsweredNativeChatPrompt(paneKey: string, answeredKey: string): void {
  if (answeredByPaneKey.get(paneKey) === answeredKey) {
    return
  }
  setBoundedScopeCacheEntry(answeredByPaneKey, paneKey, answeredKey)
  notify()
}

export function forgetAnsweredNativeChatPrompt(paneKey: string): void {
  if (answeredByPaneKey.delete(paneKey)) {
    notify()
  }
}

export function forgetAnsweredNativeChatPromptsForTab(tabId: string): void {
  const prefix = `${tabId}:`
  let changed = false
  for (const paneKey of answeredByPaneKey.keys()) {
    if (paneKey.startsWith(prefix)) {
      answeredByPaneKey.delete(paneKey)
      changed = true
    }
  }
  if (changed) {
    notify()
  }
}

export function clearAnsweredNativeChatPromptsForTests(): void {
  answeredByPaneKey.clear()
}
