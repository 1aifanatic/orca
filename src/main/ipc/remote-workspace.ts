import { ipcMain, type BrowserWindow } from 'electron'
import type { Store } from '../persistence'
import { getActiveMultiplexer, getSshConnectionStore } from './ssh'
import {
  REMOTE_WORKSPACE_CHANGED_NOTIFICATION,
  REMOTE_WORKSPACE_STALE_NOTIFICATION,
  type RemoteWorkspaceChangedEvent,
  type RemoteWorkspaceObservedSnapshot,
  type RemoteWorkspacePeerImport,
  type RemoteWorkspacePushStatusEvent
} from '../../shared/remote-workspace-types'
import { toSshExecutionHostId } from '../../shared/execution-host'
import { isFrozenOrcadSourceSessionPartition } from '../ssh/orcad-retained-source'
import { importPeerTopology } from '../persistence/terminal-topology/terminal-topology-commit'
import { createRemoteWorkspaceExports } from './remote-workspace-export'
import { getRemoteWorkspaceNamespace } from './remote-workspace-namespace'
import { registerRemoteWorkspaceNotificationHandler } from './remote-workspace-events'
import { CLIENT_ID, type RemoteWorkspaceClientNameSource } from './remote-workspace-client-identity'
import { listRemoteWorkspaceConnectedClients } from './remote-workspace-connected-clients'
import {
  clearRemoteWorkspacePatchTails,
  getRemoteWorkspacePatchTailCount
} from './remote-workspace-patch-queue'
import { getRemoteSnapshot } from './remote-workspace-relay-sync'
import {
  clearRemoteWorkspaceSnapshotCache,
  getRemoteWorkspaceSnapshotCacheSize,
  rememberLocallyPatchedRemoteWorkspaceSnapshot,
  rememberRemoteWorkspaceSnapshot
} from './remote-workspace-snapshot-cache'
import { normalizeSnapshot } from './remote-workspace-snapshot-normalization'
import {
  _resetRemoteWorkspaceStaleResyncForTests,
  resyncStaleRemoteWorkspace
} from './remote-workspace-stale-resync'

let mainWindowGetter: (() => BrowserWindow | null) | null = null
let unregisterRemoteWorkspaceNotifications: (() => void) | null = null
let unsubscribeSessionWrites: (() => void) | null = null

export function _resetRemoteWorkspaceCachesForTests(): void {
  clearRemoteWorkspaceSnapshotCache()
  clearRemoteWorkspacePatchTails()
  _resetRemoteWorkspaceStaleResyncForTests()
}

export function _getRemoteWorkspaceCacheSizesForTests(): {
  snapshots: number
  patchTails: number
} {
  return {
    snapshots: getRemoteWorkspaceSnapshotCacheSize(),
    patchTails: getRemoteWorkspacePatchTailCount()
  }
}

/** A malformed pull records nothing, so the target stays out of exports until a valid one. */
function isValidPeerImport(pull: RemoteWorkspacePeerImport): boolean {
  return (
    typeof pull.targetId === 'string' &&
    pull.targetId.length > 0 &&
    Number.isSafeInteger(pull.revision) &&
    pull.revision >= 0 &&
    typeof pull.hostObservationToken === 'string' &&
    pull.hostObservationToken.length > 0 &&
    pull.hostObservationToken.length <= 128 &&
    ['synced', 'kept-local', 'conflict'].includes(pull.outcome) &&
    typeof pull.session === 'object' &&
    pull.session !== null &&
    !Array.isArray(pull.session)
  )
}

function sendRemoteWorkspaceChanged(
  targetId: string,
  snapshot: RemoteWorkspaceObservedSnapshot,
  sourceClientId: string | undefined
): void {
  const event: RemoteWorkspaceChangedEvent = {
    targetId,
    snapshot,
    ...(sourceClientId !== undefined ? { sourceClientId } : {})
  }
  const win = mainWindowGetter?.()
  if (win && !win.isDestroyed()) {
    win.webContents.send('remoteWorkspace:changed', event)
  }
}

function sendRemoteWorkspacePushStatus(event: RemoteWorkspacePushStatusEvent): void {
  const win = mainWindowGetter?.()
  if (win && !win.isDestroyed()) {
    win.webContents.send('remoteWorkspace:pushStatus', event)
  }
}

export function handleRemoteWorkspaceNotification(
  targetId: string,
  method: string,
  params: Record<string, unknown>
): void {
  if (method === REMOTE_WORKSPACE_STALE_NOTIFICATION) {
    const target = getSshConnectionStore()?.getTarget(targetId)
    if (!target) {
      return
    }
    // No sourceClientId on the resynced event: the marker names no author, and guessing one would
    // let the renderer's own-echo filter discard another device's change.
    void resyncStaleRemoteWorkspace(target, (snapshot) =>
      sendRemoteWorkspaceChanged(targetId, snapshot, undefined)
    )
    return
  }
  if (method !== REMOTE_WORKSPACE_CHANGED_NOTIFICATION) {
    return
  }
  const target = getSshConnectionStore()?.getTarget(targetId)
  if (!target) {
    return
  }
  const namespace = getRemoteWorkspaceNamespace(target)
  const snapshot = normalizeSnapshot(params.snapshot, namespace)
  const sourceClientId =
    typeof params.sourceClientId === 'string' ? params.sourceClientId : undefined
  const observedSnapshot =
    sourceClientId === CLIENT_ID
      ? rememberLocallyPatchedRemoteWorkspaceSnapshot(targetId, snapshot)
      : rememberRemoteWorkspaceSnapshot(targetId, snapshot)
  sendRemoteWorkspaceChanged(targetId, observedSnapshot, sourceClientId)
}

export function registerRemoteWorkspaceHandlers(
  store: Store,
  getMainWindow: () => BrowserWindow | null,
  clientNameSource: RemoteWorkspaceClientNameSource
): void {
  mainWindowGetter = getMainWindow
  unregisterRemoteWorkspaceNotifications?.()
  unregisterRemoteWorkspaceNotifications = registerRemoteWorkspaceNotificationHandler(
    handleRemoteWorkspaceNotification
  )
  const exports = createRemoteWorkspaceExports(store, sendRemoteWorkspacePushStatus)
  unsubscribeSessionWrites?.()
  unsubscribeSessionWrites = store.onWorkspaceSessionWritten(exports.exportChanged)
  ipcMain.removeHandler('remoteWorkspace:get')
  ipcMain.removeHandler('remoteWorkspace:importPeerTopology')
  ipcMain.removeHandler('remoteWorkspace:listEnabledConnectedTargets')
  ipcMain.removeHandler('remoteWorkspace:listConnectedClients')
  ipcMain.removeHandler('remoteWorkspace:clientId')

  ipcMain.handle('remoteWorkspace:get', async (_event, args: { targetId: string }) => {
    const target = getSshConnectionStore()?.getTarget(args.targetId)
    if (!target) {
      return null
    }
    return getRemoteSnapshot(target)
  })

  // The window imports a host's snapshot through main: only that host's partition is written, and
  // the agreement it sets keeps the import from exporting back.
  ipcMain.handle(
    'remoteWorkspace:importPeerTopology',
    (_event, pull: RemoteWorkspacePeerImport | undefined) => {
      if (!pull || !isValidPeerImport(pull)) {
        return
      }
      if (!isFrozenOrcadSourceSessionPartition(store, toSshExecutionHostId(pull.targetId))) {
        importPeerTopology(store, pull.targetId, pull.session)
      }
      exports.recordPull(pull)
    }
  )

  ipcMain.handle(
    'remoteWorkspace:listEnabledConnectedTargets',
    async () =>
      getSshConnectionStore()
        ?.listTargets()
        .filter((target) => getActiveMultiplexer(target.id))
        .map((target) => target.id) ?? []
  )

  ipcMain.handle(
    'remoteWorkspace:listConnectedClients',
    async (_event, args?: { targetIds?: string[] }) =>
      listRemoteWorkspaceConnectedClients(args, clientNameSource)
  )

  ipcMain.handle('remoteWorkspace:clientId', () => CLIENT_ID)
}
