// Type-only and electron-free: the worker entry and the main-process client both import it.

import type { OpenCodeSessionCursor } from './opencode-binder-sessions-result'

type CursorProfileRequest = {
  id: number
  kind: 'cursorProfile'
  dbPath: string
}

type OpenCodeBinderSessionsRequest = {
  id: number
  kind: 'openCodeBinderSessions'
  dbPath: string
  cursor: OpenCodeSessionCursor
}

type OpenCodeGoKeyRequest = {
  id: number
  kind: 'openCodeGoKey'
  /** Probe order; the first database holding a key wins. */
  dbPaths: string[]
}

export type CodexIndexStatusQuery =
  | {
      type: 'backfill'
      codexHomePath: string
      /** Rollouts are counted, up to this many, only when no backfill row says otherwise. */
      sessionFileLimit: number
    }
  | { type: 'indexedThreadIds'; codexHomePath: string }
  | { type: 'sessionFileCount'; sessionsRoot: string; limit: number }

type CodexIndexStatusRequest = {
  id: number
  kind: 'codexIndexStatus'
  query: CodexIndexStatusQuery
}

export type ForeignSqliteReaderRequest =
  | CursorProfileRequest
  | OpenCodeBinderSessionsRequest
  | OpenCodeGoKeyRequest
  | CodexIndexStatusRequest

export type ForeignSqliteReaderKind = ForeignSqliteReaderRequest['kind']

export type ForeignSqliteReaderResponse =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; error: string }
