import { useSyncExternalStore, type Dispatch, type SetStateAction } from 'react'
import type { MobileNativeChatLaunchDraftSeed } from './use-mobile-native-chat-launch-draft-seed'

// Why: composer drafts, keyed by scope (host + worktree + tab), live outside the
// session screen so leaving it (Back to the workspace list) and returning keeps
// what was typed. Desktop also keeps its drafts outside the composer.
type Drafts = Record<string, string>

let drafts: Drafts = {}
const listeners = new Set<() => void>()

// Seeded launch-context text per scope; null marks a permanent decline so a
// cleared composer never resurrects the prefill, even after leaving the screen.
export const mobileNativeChatLaunchDraftSeeds = new Map<
  string,
  MobileNativeChatLaunchDraftSeed | null
>()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export const setMobileNativeChatDrafts: Dispatch<SetStateAction<Drafts>> = (update) => {
  const next = typeof update === 'function' ? update(drafts) : update
  if (next === drafts) {
    return
  }
  drafts = next
  for (const listener of listeners) {
    listener()
  }
}

export function useMobileNativeChatDraft(draftKey: string | null): string {
  const read = (): string => (draftKey ? (drafts[draftKey] ?? '') : '')
  return useSyncExternalStore(subscribe, read, read)
}

export function resetMobileNativeChatDraftStoreForTests(): void {
  drafts = {}
  mobileNativeChatLaunchDraftSeeds.clear()
}
