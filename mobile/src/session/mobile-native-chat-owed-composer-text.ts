// Withdrawn queued text owed back to a pane's composer. The composer's drafts
// live only while the session screen is open, but a Stop, /clear or Edit can be
// answered after it closed, so restored text is parked here by composer scope
// and taken exactly once by that pane's composer while its scope is active.
// Process lifetime, like the composer draft it lands in.

const owed = new Map<string, string[]>()
const listeners = new Set<() => void>()

export function oweComposerText(draftKey: string, text: string): void {
  if (!draftKey || text.length === 0) {
    return
  }
  owed.set(draftKey, [...(owed.get(draftKey) ?? []), text])
  for (const listener of listeners) {
    listener()
  }
}

/** Removes and returns everything owed to `draftKey`, oldest first. */
export function takeOwedComposerText(draftKey: string): string[] {
  const texts = owed.get(draftKey) ?? []
  owed.delete(draftKey)
  return texts
}

export function subscribeOwedComposerText(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Test-only: a fresh app process. */
export function resetOwedComposerTextForTests(): void {
  owed.clear()
  listeners.clear()
}
