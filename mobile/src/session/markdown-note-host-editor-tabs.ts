import { SESSION_TABS_HOST_EDITOR_TABS_RUNTIME_CAPABILITY } from '../../../src/shared/protocol-version'
import type { MobileFileMutationRuntimeStatus } from '../files/mobile-file-mutation-ownership'

export const MARKDOWN_NOTE_NEEDS_HOST_UPDATE_MESSAGE =
  'Update Orca on this computer to create notes from your phone'

/**
 * Whether the host is known to refuse opening a new note as a tab, read from this tap's own status.
 * Only a host without the capability that reports a window state other than `available` is known
 * to refuse; an absent or unrecognised state is unknown and the note is still attempted.
 */
export function hostRefusesMarkdownNoteTab(status: MobileFileMutationRuntimeStatus): boolean {
  if (status.capabilities?.includes(SESSION_TABS_HOST_EDITOR_TABS_RUNTIME_CAPABILITY)) {
    return false
  }
  switch (status.desktopWindowStatus) {
    case 'openable':
    case 'initializing':
    case 'blocked':
      return true
    case 'available':
    case undefined:
      return false
  }
}
