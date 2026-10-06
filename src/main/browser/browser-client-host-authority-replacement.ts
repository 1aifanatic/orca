import { BROWSER_CLIENT_HOST_AUTHORITY_MISMATCH_CODE } from '../../shared/browser-client-host-protocol'

/**
 * True when a lease failed because the runtime it named has been replaced by a newer one.
 *
 * This is the restart signal: the webview guests are still alive and still ours, and the
 * replacement authority arrives later to reclaim them, so the composition parks for it.
 */
export function isBrowserClientHostAuthorityReplaced(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }
  const code = (error as { code?: unknown }).code
  if (code === BROWSER_CLIENT_HOST_AUTHORITY_MISMATCH_CODE) {
    return true
  }
  // Legacy fallback: a runtime older than the typed code reports the same condition as a generic
  // `runtime_error` carrying the code as its message. Dropping this would make restart survival
  // regress to a teardown whenever a new client talks to an older host.
  return error.message === BROWSER_CLIENT_HOST_AUTHORITY_MISMATCH_CODE
}
