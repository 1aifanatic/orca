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
