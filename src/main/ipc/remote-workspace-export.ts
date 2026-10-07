import type { Store } from '../persistence'
import type { SshTarget } from '../../shared/ssh-types'
import type {
  RemoteWorkspaceExportAuthority,
  RemoteWorkspaceObservedPatchResult,
  RemoteWorkspacePeerImport,
  RemoteWorkspacePushStatusEvent,
  RemoteWorkspaceSession
} from '../../shared/remote-workspace-types'
import { createRepoRowExecutionHostLookup } from '../../shared/worktree-execution-host-resolution'
import { getActiveMultiplexer, getSshConnectionStore } from './ssh'
import {
  createWorktreeOwnerResolver,
  createWorktreeTargetResolver,
  exportSessionForTarget,
  persistedSessionForTarget,
  type WorktreeOwnerResolver
} from './remote-workspace-target-session-export'
import { queueRemoteWorkspacePatch } from './remote-workspace-patch-queue'
import { getRemoteSnapshot, patchRemoteWorkspaceSession } from './remote-workspace-relay-sync'
import {
  cachedRemoteWorkspaceSnapshotAuthorizesRevision,
  getCachedRemoteWorkspaceSnapshot
} from './remote-workspace-snapshot-cache'
import { remoteWorkspaceSessionsMatch } from './remote-workspace-snapshot-normalization'

/** What this desktop and a host agree the host holds; null when the host's copy is unknown. */
type HostAgreement = RemoteWorkspaceExportAuthority & { session: RemoteWorkspaceSession | null }

export type RemoteWorkspaceExports = {
  /** Records a window's pull; the import's own writes must already be in the store. */
  recordPull: (pull: Omit<RemoteWorkspacePeerImport, 'patches'>) => void
  /** Run after every session write: exports to each agreed host whose share of it changed. */
  exportChanged: () => void
}

/**
 * Exports this desktop's session to its SSH hosts. An export goes only when what this desktop holds
 * for a host differs from what the two last agreed on, so an import (which sets the agreement) and
 * the mirror apply it causes never export, while a local change exports once.
 */
export function createRemoteWorkspaceExports(
  store: Store,
  sendPushStatus: (event: RemoteWorkspacePushStatusEvent) => void
): RemoteWorkspaceExports {
  const agreements = new Map<string, HostAgreement>()
  let exportQueued = false

  const readWorktreeOwners = (): WorktreeOwnerResolver =>
    createWorktreeOwnerResolver(createRepoRowExecutionHostLookup(store.getRepos()))
  const sessionForTarget = (
    resolveWorktreeOwner: WorktreeOwnerResolver,
    targetId: string
  ): RemoteWorkspaceSession =>
    exportSessionForTarget(
      createWorktreeTargetResolver(resolveWorktreeOwner),
      targetId,
      persistedSessionForTarget(store, targetId, resolveWorktreeOwner)
    )

  const exportTo = async (
    target: SshTarget,
    session: RemoteWorkspaceSession,
    agreement: HostAgreement
  ): Promise<void> => {
    if (
      agreements.get(target.id) !== agreement ||
      (agreement.session && remoteWorkspaceSessionsMatch(session, agreement.session))
    ) {
      return
    }
    let result: RemoteWorkspaceObservedPatchResult | null
    try {
      result = await patchUnderAgreement(target, session, agreement)
    } catch (error) {
      if (agreements.get(target.id) !== agreement) {
        return
      }
      sendPushStatus({
        targetId: target.id,
        authority: agreement,
        result: null,
        error: error instanceof Error ? error.message : 'Workspace upload failed'
      })
      return
    }
    // A pull that landed meanwhile is newer than this export's outcome.
    if (agreements.get(target.id) !== agreement) {
      return
    }
    if (result?.ok) {
      const { revision, hostObservationToken } = result.snapshot
      agreements.set(target.id, { revision, hostObservationToken, session })
    } else if (result?.reason === 'stale-revision') {
      // The host moved on; the window's next pull agrees again.
      agreements.delete(target.id)
    }
    sendPushStatus({ targetId: target.id, authority: agreement, result })
  }

  const exportAll = async (): Promise<void> => {
    const targets =
      getSshConnectionStore()
        ?.listTargets()
        .filter((target) => agreements.has(target.id) && getActiveMultiplexer(target.id)) ?? []
    if (targets.length === 0) {
      return
    }
    // One catalog read and one ownership resolution per worktree, shared by every target.
    const resolveWorktreeOwner = readWorktreeOwners()
    await Promise.all(
      targets.map((target) => {
        const session = sessionForTarget(resolveWorktreeOwner, target.id)
        // Each target has its own revision stream; one slow relay must not block another.
        return queueRemoteWorkspacePatch(target.id, async () => {
          const agreement = agreements.get(target.id)
          return agreement ? exportTo(target, session, agreement) : undefined
        })
      })
    )
  }

  const exportChanged = (): void => {
    // A write burst in one turn exports once.
    if (exportQueued) {
      return
    }
    exportQueued = true
    queueMicrotask(() => {
      exportQueued = false
      void exportAll()
    })
  }

  const recordPull: RemoteWorkspaceExports['recordPull'] = ({
    targetId,
    revision,
    hostObservationToken,
    outcome
  }) => {
    if (outcome === 'conflict') {
      agreements.delete(targetId)
      return
    }
    // An import agrees on what this desktop now holds, so it never exports back. A host never
    // written (revision 0) had nothing to import: agree on its own copy, and anything this desktop
    // holds beyond it seeds the host.
    const session =
      revision === 0
        ? (getCachedRemoteWorkspaceSnapshot(targetId)?.session ?? null)
        : sessionForTarget(readWorktreeOwners(), targetId)
    agreements.set(targetId, { revision, hostObservationToken, session })
    exportChanged()
  }

  return { recordPull, exportChanged }
}

/** Patches only while the host is still at the revision and observation this desktop agreed on. */
async function patchUnderAgreement(
  target: SshTarget,
  session: RemoteWorkspaceSession,
  agreement: HostAgreement
): Promise<RemoteWorkspaceObservedPatchResult | null> {
  const current = getCachedRemoteWorkspaceSnapshot(target.id) ?? (await getRemoteSnapshot(target))
  if (
    !current ||
    current.hostObservationToken !== agreement.hostObservationToken ||
    !cachedRemoteWorkspaceSnapshotAuthorizesRevision(target.id, agreement.revision)
  ) {
    const latest = getCachedRemoteWorkspaceSnapshot(target.id) ?? current
    return latest ? { ok: false, reason: 'stale-revision', snapshot: latest } : null
  }
  return patchRemoteWorkspaceSession(target, session)
}
