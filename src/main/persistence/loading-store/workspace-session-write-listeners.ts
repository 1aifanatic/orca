import type { StoreRuntimeState } from './store-runtime-state'

const WORKSPACE_SESSION_DOMAINS: readonly string[] = [
  'workspaceSession',
  'workspaceSessionsByHostId'
]
let observerFailureLogged = false

/** `dirtyDomains` undefined means a full save, which may carry an in-place session edit. */
export function notifyWorkspaceSessionWritten(
  runtime: Pick<StoreRuntimeState, 'workspaceSessionWriteListeners'>,
  dirtyDomains?: readonly string[]
): void {
  if (
    runtime.workspaceSessionWriteListeners.size === 0 ||
    (dirtyDomains && !dirtyDomains.some((domain) => WORKSPACE_SESSION_DOMAINS.includes(domain)))
  ) {
    return
  }
  for (const listener of runtime.workspaceSessionWriteListeners) {
    // An observer failure must never fail or reorder the save that notified it.
    try {
      listener()
    } catch (error) {
      if (!observerFailureLogged) {
        observerFailureLogged = true
        console.warn('[persistence] workspace session write observer failed:', error)
      }
    }
  }
}
