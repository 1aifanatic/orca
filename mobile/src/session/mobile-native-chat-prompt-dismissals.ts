// Dismissed prompt occurrences per chat tab, kept outside the controller so leaving the session
// and coming back cannot reshow one. Entries die when an observation supersedes them, or by the bound.

export type MobileNativeChatPromptDismissal = {
  sessionKey: string | null
  promptKey: string
  /** Answered: the card is gone. Collapsed: the user folded it to a strip above the composer. */
  state: 'answered' | 'collapsed'
}

const MAX_DISMISSALS = 64
const dismissals = new Map<string, MobileNativeChatPromptDismissal>()
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) {
    listener()
  }
}

export function subscribeMobileNativeChatPromptDismissals(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function readMobileNativeChatPromptDismissal(
  key: string
): MobileNativeChatPromptDismissal | undefined {
  return dismissals.get(key)
}

export function writeMobileNativeChatPromptDismissal(
  key: string,
  dismissal: MobileNativeChatPromptDismissal
): void {
  // Why delete first: re-inserting keeps the newest answer last, so the bound drops the oldest.
  dismissals.delete(key)
  dismissals.set(key, dismissal)
  for (const oldest of dismissals.keys()) {
    if (dismissals.size <= MAX_DISMISSALS) {
      break
    }
    dismissals.delete(oldest)
  }
  notify()
}

export function forgetMobileNativeChatPromptDismissal(key: string): void {
  if (dismissals.delete(key)) {
    notify()
  }
}

export function clearMobileNativeChatPromptDismissalsForTests(): void {
  dismissals.clear()
}
