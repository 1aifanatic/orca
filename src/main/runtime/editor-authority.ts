import type { RuntimeNotifier } from './runtime-notifier-contract'

export type EditorAuthority = 'window' | 'host'

export type EditorAuthorityHost = {
  getAvailableAuthoritativeWindow(): unknown
  readonly notifier: Pick<
    RuntimeNotifier,
    'openFile' | 'openDiff' | 'readMobileMarkdownTab' | 'saveMobileMarkdownTab'
  > | null
}

/**
 * Who owns editor tabs right now. Derived on every call and never stored: a window owns them from
 * the moment it is assigned (before its document reads the session) until it closes or a failed
 * promotion hands authority back; otherwise the host does.
 */
export function resolveEditorAuthority(host: EditorAuthorityHost): EditorAuthority {
  const notifier = host.notifier
  return host.getAvailableAuthoritativeWindow() &&
    notifier?.openFile &&
    notifier.openDiff &&
    notifier.readMobileMarkdownTab &&
    notifier.saveMobileMarkdownTab
    ? 'window'
    : 'host'
}

/** Thrown when a host editor change started without a window and one took over before it committed. */
export const EDITOR_AUTHORITY_CHANGED_ERROR = "The computer's Orca window just opened. Try again."

export function assertHostEditorAuthority(host: EditorAuthorityHost): void {
  if (resolveEditorAuthority(host) !== 'host') {
    throw new Error(EDITOR_AUTHORITY_CHANGED_ERROR)
  }
}
