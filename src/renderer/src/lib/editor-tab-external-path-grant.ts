import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import { settingsForRuntimeOwner } from '@/runtime/runtime-client-target'
import type { OpenFile } from '@/store/slices/editor'
import type { AppState } from '@/store/types'
import { getConnectionIdForFile } from './connection-context'

type EditorTabPathGrantFile = Pick<
  OpenFile,
  'filePath' | 'relativePath' | 'worktreeId' | 'runtimeEnvironmentId' | 'externalSshTargetId'
>

/**
 * The client-local path a restored editor tab may need re-granted, decided by who owns the tab.
 * Main decides whether a project root already covers it.
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
  if (file.worktreeId === FLOATING_TERMINAL_WORKTREE_ID) {
    return file.filePath
  }
  // Why null only: an SSH, ambiguous or not-yet-loaded owner may mean the path lives on another host.
  if (
    file.relativePath !== file.filePath ||
    getConnectionIdForFile(file.worktreeId, file.filePath) !== null
  ) {
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
  return targetPath
    ? window.api.fs.authorizeExternalPath({ targetPath, skipIfInsideAllowedRoots: true })
    : null
}
