// Why: while a gated reseed waits on agent detection, it owns the workspace's first surface;
// any other seeder landing in that wait would put a shell beside the chat it is about to open.
const workspacesAwaitingDefaultSurface = new Set<string>()

/** False when another reseed already owns this workspace's default surface. */
export function claimEmptyWorkspaceDefaultSurface(workspaceKey: string): boolean {
  if (workspacesAwaitingDefaultSurface.has(workspaceKey)) {
    return false
  }
  workspacesAwaitingDefaultSurface.add(workspaceKey)
  return true
}

export function releaseEmptyWorkspaceDefaultSurface(workspaceKey: string): void {
  workspacesAwaitingDefaultSurface.delete(workspaceKey)
}

export function isEmptyWorkspaceDefaultSurfacePending(workspaceKey: string): boolean {
  return workspacesAwaitingDefaultSurface.has(workspaceKey)
}
