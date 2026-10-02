import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import { settingsForRuntimeOwner } from '@/runtime/runtime-client-target'
import type { OpenFile } from '@/store/slices/editor'
import type { AppState } from '@/store/types'
import { getConnectionIdForFile, isWorktreeConnectionResolved } from './connection-context'
import { findWorkspaceFileRoute } from './runtime-workspace-file-route'

type EditorTabPathGrantFile = Pick<
  OpenFile,
  'filePath' | 'relativePath' | 'worktreeId' | 'runtimeEnvironmentId' | 'externalSshTargetId'
>

/**
 * The client-local path an editor tab needs re-granted before main will read or
 * write it, or null when an authorized project root (or a remote host) owns it.
 */
export function getEditorTabExternalPathGrantTarget(
  state: AppState,
  file: EditorTabPathGrantFile
): string | null {
  const runtimeOwner = settingsForRuntimeOwner(state.settings, file.runtimeEnvironmentId)
  if (file.externalSshTargetId?.trim() || runtimeOwner?.activeRuntimeEnvironmentId?.trim()) {
    return null
  }
  // Why: the floating workspace root (`~` by default) is deliberately not an authorized root,
  // so its tabs need a grant even though they store a root-relative path.
  if (file.worktreeId !== FLOATING_TERMINAL_WORKTREE_ID) {
    if (file.relativePath !== file.filePath) {
      return null
    }
    const connectionId = getConnectionIdForFile(file.worktreeId, file.filePath)
    // Why: an SSH owner reads remotely, and an unhydrated owner can't be told apart from one.
    if (
      connectionId ||
      (connectionId === undefined && !isWorktreeConnectionResolved(file.worktreeId))
    ) {
      return null
    }
  }
  // Why: a project root already authorizes this path; a grant would also authorize a project symlink's outside target.
  if (findWorkspaceFileRoute(state, LOCAL_EXECUTION_HOST_ID, file.filePath)) {
    return null
  }
  return file.filePath
}

/**
 * Main's external-path grants live only in memory, so every reader of a restored tab re-derives
 * its own. Null when no grant is needed, so callers can keep their read on the same tick.
 */
export function refreshEditorTabExternalPathGrant(
  state: AppState,
  file: EditorTabPathGrantFile
): Promise<void> | null {
  const targetPath = getEditorTabExternalPathGrantTarget(state, file)
  return targetPath ? window.api.fs.authorizeExternalPath({ targetPath }) : null
}
