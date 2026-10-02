import type {
  ForeignSqliteReaderRequest,
  ForeignSqliteReaderResponse
} from './foreign-sqlite-reader-protocol'
import { readCodexIndexStatus } from './readers/codex-index-status'
import { readCursorProfile } from './readers/cursor-profile'
import { readHermesSessionRunRefRows, readHermesSessionRuns } from './readers/hermes-session-runs'
import { readOpenCodeBinderSessions } from './readers/opencode-binder-sessions'
import { readOpenCodeGoKey } from './readers/opencode-go-key'

/**
 * Run one foreign-app SQLite read on the worker thread.
 * @param request - A structured clone from the main process; its kind is untrusted.
 * @returns The reader's value, or an error naming a kind no reader owns.
 */
export function handleForeignSqliteReaderRequest(
  request: ForeignSqliteReaderRequest
): ForeignSqliteReaderResponse {
  // Destructured from the parameter so `kind` narrows `request` and ends as `never`.
  const { id, kind } = request
  try {
    switch (kind) {
      case 'cursorProfile':
        return { id, ok: true, value: readCursorProfile(request.dbPath) }
      case 'openCodeBinderSessions':
        return { id, ok: true, value: readOpenCodeBinderSessions(request.dbPath, request.cursor) }
      case 'openCodeGoKey':
        return { id, ok: true, value: readOpenCodeGoKey(request.dbPaths) }
      case 'codexIndexStatus':
        return { id, ok: true, value: readCodexIndexStatus(request.query) }
      case 'hermesSessionRunRefs':
        return { id, ok: true, value: readHermesSessionRunRefRows(request.dbPath, request.jobId) }
      case 'hermesSessionRuns':
        return { id, ok: true, value: readHermesSessionRuns(request.dbPath, request.runIds) }
    }
    // A structured clone can carry any kind; one without a reader is refused, not guessed at.
    return unknownKind(id, kind)
  } catch (err) {
    return { id, ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

// Why `never`: adding a request kind without a case here fails to compile.
function unknownKind(id: number, kind: never): ForeignSqliteReaderResponse {
  return { id, ok: false, error: `Unknown foreign SQLite reader kind: ${String(kind)}` }
}
