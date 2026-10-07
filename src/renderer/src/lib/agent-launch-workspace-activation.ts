/**
 * The workspace a desktop `agent.launch` create opened, by that launch's operation id.
 *
 * The host names the launch on the activation it already sends when the create opens the
 * workspace, before the launch answers (which waits on prompt delivery). A window waiting on a
 * launch hears its workspace here at that moment; the launch's answer carries the same
 * `worktreeId`, so a window that misses this still learns it.
 */

type Listener = (worktreeId: string) => void

const listeners = new Map<string, Set<Listener>>()

export function onAgentLaunchWorkspaceActivated(
  operationId: string,
  listener: Listener
): () => void {
  const forLaunch = listeners.get(operationId) ?? new Set<Listener>()
  forLaunch.add(listener)
  listeners.set(operationId, forLaunch)
  return () => {
    forLaunch.delete(listener)
    if (forLaunch.size === 0 && listeners.get(operationId) === forLaunch) {
      listeners.delete(operationId)
    }
  }
}

/** A launch nobody here waits on (another window's, or one this window gave up on) is ignored. */
export function noteAgentLaunchWorkspaceActivated(operationId: string, worktreeId: string): void {
  for (const listener of listeners.get(operationId) ?? []) {
    listener(worktreeId)
  }
}
