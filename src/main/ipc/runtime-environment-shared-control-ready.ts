const listeners = new Set<(environmentId: string) => void>()

/** Fires each time an environment's shared control connection becomes ready again. */
export function onRemoteRuntimeSharedControlReady(
  listener: (environmentId: string) => void
): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function notifyRemoteRuntimeSharedControlReady(environmentId: string): void {
  for (const listener of listeners) {
    try {
      listener(environmentId)
    } catch (error) {
      console.warn('[runtime-environments] shared control ready listener failed:', error)
    }
  }
}
