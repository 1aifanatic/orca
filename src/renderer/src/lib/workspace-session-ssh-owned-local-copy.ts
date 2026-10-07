import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../shared/execution-host'
import { normalizeWorkspaceSessionKeyToWorkspaceId } from '../../../shared/workspace-scope'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { workspaceIdsNamedByPartition } from '../../../shared/workspace-session-stranded-partition-adoption'
import {
  mergeWorkspaceSessionsFromHosts,
  splitWorkspaceSessionByHost
} from './workspace-session-host-split'

/**
 * At startup a local copy never overrides an SSH-owned workspace's own copy.
 *
 * Rows `local` holds for a workspace whose repo the catalog places on an SSH target are residue:
 * builds before #19572 wrote them, and relay reattach kept writing them (#25616). Left in the base,
 * they made adoption skip the SSH partition, so closed tabs came back, live ones were dropped and
 * agent-resume records were erased by the first save (#23390). Dropping them here lets adoption
 * take that partition whole, and the next write routes the workspace there, so `local` loses them.
 */
// No real SSH target has an empty id, so no host-qualified key can route to this slice.
const SHADOWED_LOCAL_COPY: ExecutionHostId = 'ssh:'

export function withoutLocalCopiesOfSshOwnedWorkspaces(
  session: WorkspaceSessionState,
  attribution: {
    /** Workspaces the repo catalog resolves to the ssh partition that names them. */
    sshOwnedWorkspaceIds: ReadonlySet<string>
    contestedSessionKeys: ReadonlySet<string>
  }
): WorkspaceSessionState {
  // A contested id may be two workspaces, so its local copy is not residue.
  const sshOwnedWorkspaceIds = new Set(attribution.sshOwnedWorkspaceIds)
  for (const key of attribution.contestedSessionKeys) {
    sshOwnedWorkspaceIds.delete(normalizeWorkspaceSessionKeyToWorkspaceId(key))
  }
  const shadowed = [...workspaceIdsNamedByPartition(session)].some((workspaceId) =>
    sshOwnedWorkspaceIds.has(workspaceId)
  )
  if (!shadowed) {
    return session
  }
  // Why the write path's own split: it routes tab-, pane- and file-keyed rows by the same indexes
  // the write uses, so every row of those workspaces leaves together and nothing else does.
  const slices = splitWorkspaceSessionByHost(session, (key) =>
    sshOwnedWorkspaceIds.has(normalizeWorkspaceSessionKeyToWorkspaceId(key))
      ? SHADOWED_LOCAL_COPY
      : LOCAL_EXECUTION_HOST_ID
  )
  delete slices[SHADOWED_LOCAL_COPY]
  const kept = mergeWorkspaceSessionsFromHosts(slices)
  // Why these two stay: an unsaved draft lives only in open files, and neither field can resurrect
  // a tab. Adoption still replaces them wherever the SSH partition holds rows of its own.
  if (session.openFilesByWorktree) {
    kept.openFilesByWorktree = withShadowedRows(
      kept.openFilesByWorktree ?? {},
      session.openFilesByWorktree,
      sshOwnedWorkspaceIds
    )
  }
  if (session.lastVisitedAtByWorktreeId) {
    kept.lastVisitedAtByWorktreeId = withShadowedRows(
      kept.lastVisitedAtByWorktreeId ?? {},
      session.lastVisitedAtByWorktreeId,
      sshOwnedWorkspaceIds
    )
  }
  return kept
}

function withShadowedRows<T>(
  kept: Record<string, T>,
  original: Record<string, T>,
  sshOwnedWorkspaceIds: ReadonlySet<string>
): Record<string, T> {
  const shadowed = Object.entries(original).filter(([key]) =>
    sshOwnedWorkspaceIds.has(normalizeWorkspaceSessionKeyToWorkspaceId(key))
  )
  return shadowed.length === 0 ? kept : { ...kept, ...Object.fromEntries(shadowed) }
}
