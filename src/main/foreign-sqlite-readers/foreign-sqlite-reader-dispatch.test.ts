import { describe, expect, it } from 'vitest'
import { handleForeignSqliteReaderRequest } from './foreign-sqlite-reader-dispatch'

describe('handleForeignSqliteReaderRequest', () => {
  it('routes cursorProfile to its reader', () => {
    expect(
      handleForeignSqliteReaderRequest({
        id: 4,
        kind: 'cursorProfile',
        dbPath: '/definitely/missing/state.vscdb'
      })
    ).toEqual({ id: 4, ok: true, value: { status: 'missing' } })
  })

  it('routes openCodeBinderSessions to its reader and reports a failed open as an error', () => {
    const response = handleForeignSqliteReaderRequest({
      id: 5,
      kind: 'openCodeBinderSessions',
      dbPath: '/definitely/missing/opencode.db',
      cursor: { ms: 0, id: '' }
    })
    expect(response).toMatchObject({ id: 5, ok: false })
  })

  it('routes openCodeGoKey and codexIndexStatus to their readers', () => {
    expect(handleForeignSqliteReaderRequest({ id: 6, kind: 'openCodeGoKey', dbPaths: [] })).toEqual(
      { id: 6, ok: true, value: { status: 'missing' } }
    )
    expect(
      handleForeignSqliteReaderRequest({
        id: 7,
        kind: 'codexIndexStatus',
        query: { type: 'sessionFileCount', sessionsRoot: '/definitely/missing', limit: 1 }
      })
    ).toEqual({ id: 7, ok: true, value: { type: 'sessionFileCount', count: 0 } })
  })

  it('routes both Hermes kinds to their readers', () => {
    const missing = '/definitely/missing/state.db'
    expect(
      handleForeignSqliteReaderRequest({
        id: 8,
        kind: 'hermesSessionRunRefs',
        dbPath: missing,
        jobId: 'j'
      })
    ).toMatchObject({ id: 8, ok: false })
    expect(
      handleForeignSqliteReaderRequest({
        id: 10,
        kind: 'hermesSessionRuns',
        dbPath: missing,
        runIds: ['r']
      })
    ).toMatchObject({ id: 10, ok: false })
  })

  it('rejects a kind no reader owns instead of running one', () => {
    // Parsed, as a structured clone arrives: untyped, with a kind outside the union.
    const request = JSON.parse('{"id":9,"kind":"list","dbPaths":[]}')
    expect(handleForeignSqliteReaderRequest(request)).toEqual({
      id: 9,
      ok: false,
      error: 'Unknown foreign SQLite reader kind: list'
    })
  })
})
