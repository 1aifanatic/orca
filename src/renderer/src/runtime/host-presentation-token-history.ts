// Why a short history: an exit is fenced by the token current when its bytes arrived, which may
// be a snapshot or two before the one applied when the queued exit finally drains.
const MAX_TOKENS_PER_TAB = 8
const MAX_TRACKED_TABS = 512

type TokenSighting = { token: string; seenAtMs: number }

const historyByHostTab = new Map<string, TokenSighting[]>()

function key(worktreeId: string, hostTabId: string): string {
  return `${worktreeId}\0${hostTabId}`
}

/** Records the presentation token a paired host published for one of its terminal tabs. */
export function noteHostPresentationToken(
  worktreeId: string,
  hostTabId: string,
  token: string | undefined,
  nowMs = Date.now()
): void {
  if (!token) {
    return
  }
  const id = key(worktreeId, hostTabId)
  const history = historyByHostTab.get(id) ?? []
  if (history.at(-1)?.token === token) {
    return
  }
  history.push({ token, seenAtMs: nowMs })
  if (history.length > MAX_TOKENS_PER_TAB) {
    history.shift()
  }
  historyByHostTab.delete(id)
  historyByHostTab.set(id, history)
  if (historyByHostTab.size > MAX_TRACKED_TABS) {
    const oldest = historyByHostTab.keys().next().value
    if (oldest !== undefined) {
      historyByHostTab.delete(oldest)
    }
  }
}

/**
 * The host token this client held at `atMs`, or null when it held none then (or it fell out of
 * the history): without it the client cannot fence its exit, so it writes nothing.
 */
export function readHostPresentationTokenAt(
  worktreeId: string,
  hostTabId: string,
  atMs: number
): string | null {
  const history = historyByHostTab.get(key(worktreeId, hostTabId)) ?? []
  let held: string | null = null
  for (const sighting of history) {
    if (sighting.seenAtMs > atMs) {
      break
    }
    held = sighting.token
  }
  return held
}

export function resetHostPresentationTokenHistoryForTest(): void {
  historyByHostTab.clear()
}
