import { ipcMain } from 'electron'
import { vi } from 'vitest'
import type { Store } from '../persistence'
import type {
  RemoteWorkspaceChangedEvent,
  RemoteWorkspaceExportAuthority,
  RemoteWorkspacePeerImport,
  RemoteWorkspacePushStatusEvent
} from '../../shared/remote-workspace-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { registerRemoteWorkspaceHandlers } from './remote-workspace'

export const EMPTY_WORKSPACE_SESSION: WorkspaceSessionState = {
  activeRepoId: null,
  activeWorktreeId: null,
  activeTabId: null,
  tabsByWorktree: {},
  terminalLayoutsByTabId: {}
}

export type RemoteWorkspaceExportDriver = {
  handlers: Map<string, (event: unknown, args: unknown) => unknown>
  /** Every push-status report main sent, in order. */
  pushes: RemoteWorkspacePushStatusEvent[]
  /** A window's pull of `targetId` with nothing to import. */
  agree: (
    targetId: string,
    authority: RemoteWorkspaceExportAuthority,
    outcome?: RemoteWorkspacePeerImport['outcome']
  ) => void
  importPeer: (pull: RemoteWorkspacePeerImport) => void
  /** A session write by anything other than an import, patched onto the one partition. */
  write: (patch: Partial<WorkspaceSessionState>) => void
  readSession: () => WorkspaceSessionState
  /** Resolves once `count` more push reports have arrived. */
  nextPushes: (count?: number) => Promise<RemoteWorkspacePushStatusEvent[]>
}

/**
 * Registers the remote-workspace handlers against a one-partition store fake whose session writes
 * reach main's export trigger, and records the push reports main sends the window.
 */
export function createRemoteWorkspaceExportDriver(
  store: Partial<Store>,
  /** The window's `remoteWorkspace:changed` listener. */
  onChanged: (event: RemoteWorkspaceChangedEvent) => void = () => {}
): RemoteWorkspaceExportDriver {
  const handlers = new Map<string, (event: unknown, args: unknown) => unknown>()
  vi.mocked(ipcMain.handle).mockImplementation((channel, handler) => {
    handlers.set(channel, handler as (event: unknown, args: unknown) => unknown)
  })
  let session = EMPTY_WORKSPACE_SESSION
  const writeListeners = new Set<() => void>()
  const pushes: RemoteWorkspacePushStatusEvent[] = []
  const waiters = new Set<() => void>()
  const window = {
    isDestroyed: () => false,
    webContents: {
      send: (
        channel: string,
        event: RemoteWorkspacePushStatusEvent | RemoteWorkspaceChangedEvent
      ) => {
        if (channel === 'remoteWorkspace:changed' && 'snapshot' in event) {
          onChanged(event)
        } else if (channel === 'remoteWorkspace:pushStatus' && 'authority' in event) {
          pushes.push(event)
          for (const waiter of waiters) {
            waiter()
          }
        }
      }
    }
  }
  const fakeStore = {
    getSshTarget: () => undefined,
    ...store,
    getWorkspaceSession: (hostId?: string | null) =>
      !hostId || hostId === 'local' ? session : EMPTY_WORKSPACE_SESSION,
    patchWorkspaceSession: (patch: Partial<WorkspaceSessionState>) => {
      session = { ...session, ...patch }
      for (const listener of writeListeners) {
        listener()
      }
    },
    onWorkspaceSessionWritten: (listener: () => void) => {
      writeListeners.add(listener)
      return () => writeListeners.delete(listener)
    }
  }
  registerRemoteWorkspaceHandlers(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fake implements every Store member the remote-workspace handlers read.
    fakeStore as unknown as Store,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the window fake exposes only the webContents.send the handlers call.
    () => window as never,
    { readMachineName: () => 'Build server' }
  )
  const importPeer = (pull: RemoteWorkspacePeerImport): void => {
    void handlers.get('remoteWorkspace:importPeerTopology')?.(null, pull)
  }
  return {
    handlers,
    pushes,
    agree: (targetId, authority, outcome = 'synced') =>
      importPeer({ targetId, ...authority, outcome, session: {} }),
    importPeer,
    write: (patch) => fakeStore.patchWorkspaceSession(patch),
    readSession: () => session,
    nextPushes: (count = 1) => {
      const target = pushes.length + count
      return new Promise((resolve) => {
        const check = (): void => {
          if (pushes.length >= target) {
            waiters.delete(check)
            resolve(pushes.slice(target - count, target))
          }
        }
        waiters.add(check)
        check()
      })
    }
  }
}
