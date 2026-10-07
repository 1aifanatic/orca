import type {
  RemoteWorkspaceObservedPatchResult,
  RemoteWorkspacePushStatusEvent
} from '../../../shared/remote-workspace-types'
import { translate } from '@/i18n/i18n'
import { terminalLayoutNodeEqual } from '../lib/terminal-layout-equality'
import type { AppState } from '../store/types'

export type RemoteWorkspacePushAuthority = {
  revision: number
  updatedAt?: number
  hostObservationToken: string
}

function currentTransientAuthority(
  store: AppState,
  targetId: string,
  fallback: RemoteWorkspacePushAuthority
): RemoteWorkspacePushAuthority {
  const current = store.remoteWorkspaceSyncStatusByTargetId[targetId]
  return current?.hostObservationToken === fallback.hostObservationToken &&
    typeof current.revision === 'number'
    ? {
        revision: current.revision,
        updatedAt: current.updatedAt,
        hostObservationToken: current.hostObservationToken
      }
    : fallback
}

export function applyRemoteWorkspacePushStatus(
  store: AppState,
  targetId: string,
  result: RemoteWorkspaceObservedPatchResult | undefined,
  fallbackAuthority: RemoteWorkspacePushAuthority
): void {
  if (!result) {
    const authority = currentTransientAuthority(store, targetId, fallbackAuthority)
    store.setRemoteWorkspaceSyncStatus(targetId, {
      phase: 'offline',
      direction: 'push',
      ...authority,
      lastSyncedAt: Date.now(),
      message: translate('auto.hooks.useIpcEvents.2fe88c2e06', 'Remote workspace sync unavailable')
    })
  } else if (result.ok) {
    store.setRemoteWorkspaceSyncStatus(targetId, {
      phase: 'synced',
      direction: 'push',
      revision: result.snapshot.revision,
      updatedAt: result.snapshot.updatedAt,
      hostObservationToken: result.snapshot.hostObservationToken,
      lastSyncedAt: Date.now(),
      message: translate('auto.hooks.useIpcEvents.f8aaf2bde3', 'Workspace uploaded')
    })
  } else {
    const authority = result.snapshot
      ? {
          revision: result.snapshot.revision,
          updatedAt: result.snapshot.updatedAt,
          hostObservationToken: result.snapshot.hostObservationToken
        }
      : currentTransientAuthority(store, targetId, fallbackAuthority)
    store.setRemoteWorkspaceSyncStatus(targetId, {
      phase: result.reason === 'stale-revision' ? 'conflict' : 'offline',
      direction: 'push',
      ...authority,
      lastSyncedAt: Date.now(),
      message:
        result.message ??
        (result.reason === 'stale-revision'
          ? translate(
              'auto.hooks.useIpcEvents.workspaceChangedOnAnotherDevice',
              'Workspace changed on another device'
            )
          : translate('auto.hooks.useIpcEvents.2fe88c2e06', 'Remote workspace sync unavailable'))
    })
  }
}

/**
 * Main's report of an export it ran. Ignored once the window no longer holds that host's agreement:
 * mid-pull, after a conflict, or against another host observation.
 */
export function applyRemoteWorkspacePushStatusEvent(
  store: AppState,
  { targetId, authority, result, error }: RemoteWorkspacePushStatusEvent
): void {
  const status = store.remoteWorkspaceSyncStatusByTargetId[targetId]
  if (
    !store.remoteWorkspaceHydratedTargetIds.has(targetId) ||
    status?.phase === 'conflict' ||
    status?.hostObservationToken !== authority.hostObservationToken
  ) {
    return
  }
  if (error !== undefined) {
    store.setRemoteWorkspaceSyncStatus(targetId, {
      phase: 'error',
      direction: 'push',
      revision: status.revision ?? authority.revision,
      updatedAt: status.updatedAt,
      hostObservationToken: authority.hostObservationToken,
      message: error
    })
    return
  }
  if (result?.ok) {
    // An edit is acknowledged once the host holds its exact layout.
    store.acknowledgeDirectSshLayoutEdits(
      Object.fromEntries(
        Object.entries(store.pendingDirectSshLayoutEditsByTabId).filter(([tabId, edit]) => {
          const uploaded = result.snapshot.session.terminalLayoutsByTabId[tabId]
          return (
            edit.targetId === targetId &&
            uploaded &&
            terminalLayoutNodeEqual(edit.root, uploaded.root)
          )
        })
      )
    )
  }
  applyRemoteWorkspacePushStatus(store, targetId, result ?? undefined, authority)
}
