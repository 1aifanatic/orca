import type {
  RemoteWorkspaceObservedSnapshot,
  RemoteWorkspacePeerImport
} from '../../../shared/remote-workspace-types'
import type { DirectSshAuthority } from '../../../shared/ssh-types'
import type {
  DirectSshPreparationInput,
  DirectSshPreparationOutcome,
  DirectSshPreparationToken
} from './direct-ssh-reconnect-coordinator'
import type { RemoteWorkspaceSnapshotPlacementStore } from './remote-workspace-snapshot-placement'

export type RemoteWorkspaceApi = {
  get: (args: { targetId: string }) => Promise<RemoteWorkspaceObservedSnapshot | null>
  importPeerTopology: (pull: RemoteWorkspacePeerImport) => Promise<void>
}

export type RemoteWorkspaceTargetSyncDeps = {
  store: RemoteWorkspaceSnapshotPlacementStore
  remoteWorkspace: RemoteWorkspaceApi
  getCurrentAuthority: (targetId: string) => DirectSshAuthority | null
  isPreparationTokenCurrent: (token: DirectSshPreparationToken) => boolean
  capturePreparationInput: (
    authority: DirectSshAuthority,
    reason: 'workspace-snapshot',
    snapshotRevision: number
  ) => Promise<DirectSshPreparationInput | null>
  prepareOnly: (input: DirectSshPreparationInput) => Promise<DirectSshPreparationOutcome>
  finalizeHydratedTerminals: (authority: DirectSshAuthority) => number
}

export type RemoteWorkspaceTargetSync = {
  syncAfterConnect: (token: DirectSshPreparationToken) => Promise<void>
  applyUnsolicitedSnapshot: (
    targetId: string,
    snapshot: RemoteWorkspaceObservedSnapshot
  ) => Promise<void>
  stop: () => void
}
