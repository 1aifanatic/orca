// Why: a chat the host stopped listing is gone, wherever it was closed (the phone, another window,
// while Orca was off). Noted while a sync patch is prepared, acted on only once that patch lands.
const removedSessionIds = new Set<string>()

export function noteHostRemovedStructuredChat(sessionId: string): void {
  removedSessionIds.add(sessionId)
}

export function takeHostRemovedStructuredChats(): string[] {
  const sessionIds = [...removedSessionIds]
  removedSessionIds.clear()
  return sessionIds
}
