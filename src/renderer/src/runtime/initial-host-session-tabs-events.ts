import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'

type Listener = (snapshot: RuntimeMobileSessionTabsResult, environmentId: string) => void
const listeners = new Set<Listener>()

export function subscribeInitialHostSessionTabs(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The existing publication cursor decides first receipt; no replacement identity is stored. */
export function queueInitialHostSessionTabs(
  snapshot: RuntimeMobileSessionTabsResult,
  environmentId: string
): void {
  const eligible = [...listeners]
  // Publication decisions can run inside a store updater; the binding must land first.
  queueMicrotask(() => {
    for (const listener of eligible) {
      if (listeners.has(listener)) {
        listener(snapshot, environmentId)
      }
    }
  })
}
