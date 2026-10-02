/**
 * A pane spawn its host refused because what carries the agent's prompt (a launch file, or the
 * staged script of a long line) could not be written. Kept by tab so a create waiting on that tab's
 * handle reports the reason at once instead of timing out. Entries expire; nothing waits forever.
 */
const REFUSAL_TTL_MS = 60_000
const MAX_REFUSALS = 64

const refusals = new Map<string, { message: string; at: number }>()
const listeners = new Set<(tabId: string, message: string) => void>()

export function recordTerminalLaunchRefusal(tabId: string, message: string): void {
  const now = Date.now()
  for (const [key, entry] of refusals) {
    if (now - entry.at > REFUSAL_TTL_MS || refusals.size >= MAX_REFUSALS) {
      refusals.delete(key)
    }
  }
  refusals.set(tabId, { message, at: now })
  for (const listener of listeners) {
    listener(tabId, message)
  }
}

/** The refusal recorded for `tabId`, consumed. */
export function takeTerminalLaunchRefusal(tabId: string): string | undefined {
  const entry = refusals.get(tabId)
  refusals.delete(tabId)
  return entry && Date.now() - entry.at <= REFUSAL_TTL_MS ? entry.message : undefined
}

export function onTerminalLaunchRefusal(
  listener: (tabId: string, message: string) => void
): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
