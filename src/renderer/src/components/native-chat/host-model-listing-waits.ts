import type { AgentSessionModelCatalogResult } from '../../../../shared/agent-session-wire'

// One waiting catalog read per chat, shared by every mount and effect run of that chat's picker:
// a remote read cannot be withdrawn once sent, so a re-run joins the one in flight instead of
// sending another. An entry lives exactly as long as its read.

const waits = new Map<string, Promise<AgentSessionModelCatalogResult>>()
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) {
    listener()
  }
}

/** The chat's waiting read, started by `read` only when none is in flight. Settles like `read`. */
export function joinHostModelListingWait(
  key: string,
  read: () => Promise<AgentSessionModelCatalogResult>
): Promise<AgentSessionModelCatalogResult> {
  const inFlight = waits.get(key)
  if (inFlight) {
    return inFlight
  }
  const settle = (): void => {
    waits.delete(key)
    notify()
  }
  const wait = read()
  waits.set(key, wait)
  notify()
  wait.then(settle, settle)
  return wait
}

export function isHostModelListingWaitInFlight(key: string): boolean {
  return waits.has(key)
}

export function subscribeHostModelListingWaits(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
