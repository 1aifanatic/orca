import { beforeEach, describe, expect, it, vi } from 'vitest'

const { listDatabasesMock, readGoKeyMock } = vi.hoisted(() => ({
  listDatabasesMock: vi.fn<() => Promise<string[]>>(),
  readGoKeyMock: vi.fn()
}))

vi.mock('../opencode-usage/opencode-database-discovery', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  listOpenCodeDatabases: listDatabasesMock
}))
vi.mock('../foreign-sqlite-readers/foreign-sqlite-reader-spawn', () => ({
  readOpenCodeGoKeyFromDatabases: readGoKeyMock
}))

import { readOpenCodeCredentialDatabaseGoKey } from './opencode-go-api-key-source'

const WSL_DB = '\\\\wsl.localhost\\Ubuntu\\home\\alice\\.local\\share\\opencode\\opencode.db'

beforeEach(() => {
  listDatabasesMock.mockReset()
  readGoKeyMock.mockReset()
})

describe('readOpenCodeCredentialDatabaseGoKey', () => {
  it('reads local databases on the worker in claim order and skips WSL shares', async () => {
    listDatabasesMock.mockResolvedValue(['/data/opencode-b.db', WSL_DB, '/data/opencode.db'])
    readGoKeyMock.mockResolvedValue({ status: 'found', key: 'database-placeholder-key' })

    await expect(readOpenCodeCredentialDatabaseGoKey()).resolves.toBe('database-placeholder-key')
    expect(readGoKeyMock).toHaveBeenCalledExactlyOnceWith([
      '/data/opencode.db',
      '/data/opencode-b.db'
    ])
  })

  it('does not start the reader when only WSL databases exist', async () => {
    listDatabasesMock.mockResolvedValue([WSL_DB])

    await expect(readOpenCodeCredentialDatabaseGoKey()).resolves.toBeNull()
    expect(readGoKeyMock).not.toHaveBeenCalled()
  })

  it('keeps an unreadable store, including an unanswered worker, as no key', async () => {
    listDatabasesMock.mockResolvedValue(['/data/opencode.db'])
    readGoKeyMock.mockResolvedValue({ status: 'unreadable' })

    await expect(readOpenCodeCredentialDatabaseGoKey()).resolves.toBeNull()
  })
})
