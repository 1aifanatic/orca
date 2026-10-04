import { dirname, join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { authorizeExternalPathMock, writeFileMock, mkdirMock, getPathMock, writeFileBase64Mock } =
  vi.hoisted(() => ({
    authorizeExternalPathMock: vi.fn(),
    writeFileMock: vi.fn(),
    mkdirMock: vi.fn(),
    getPathMock: vi.fn(() => '/Users/me/Library/Application Support/orca'),
    writeFileBase64Mock: vi.fn()
  }))

vi.mock('node:fs/promises', () => ({ default: { writeFile: writeFileMock, mkdir: mkdirMock } }))
vi.mock('node:crypto', () => ({ randomUUID: () => 'uuid-1' }))
vi.mock('../../shared/app-environment', () => ({
  getAppEnvironment: () => ({ getPath: getPathMock })
}))
vi.mock('../providers/ssh-filesystem-dispatch', () => ({
  requireSshFilesystemProvider: () => ({
    getTempDir: async () => '/remote/tmp',
    writeFileBase64: writeFileBase64Mock
  })
}))
vi.mock('../ipc/filesystem-auth', () => ({ authorizeExternalPath: authorizeExternalPathMock }))

import { saveClipboardImageBufferAsTempFile } from './clipboard-image-temp-file'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('saveClipboardImageBufferAsTempFile', () => {
  it('writes a local paste into the paste folder, where a restored draft can still find it', async () => {
    const savedPath = await saveClipboardImageBufferAsTempFile(Buffer.from([1, 2, 3]))

    expect(getPathMock).toHaveBeenCalledWith('userData')
    expect(mkdirMock).toHaveBeenCalledWith(
      join('/Users/me/Library/Application Support/orca', 'native-chat-pastes'),
      { recursive: true }
    )
    expect(dirname(savedPath)).toBe(
      join('/Users/me/Library/Application Support/orca', 'native-chat-pastes')
    )
  })

  it('authorizes the local paste so the composer can preview what it just wrote', async () => {
    const savedPath = await saveClipboardImageBufferAsTempFile(Buffer.from([1, 2, 3]))

    expect(writeFileMock).toHaveBeenCalledWith(savedPath, Buffer.from([1, 2, 3]))
    // The paste folder is outside every allowed root, so an unauthorized path
    // makes fs:readFile deny the preview read of Orca's own file.
    expect(authorizeExternalPathMock).toHaveBeenCalledWith(savedPath)
  })

  it('does not authorize a local path for an SSH save', async () => {
    const savedPath = await saveClipboardImageBufferAsTempFile(Buffer.from([1]), {
      connectionId: 'conn-1'
    })

    expect(savedPath.startsWith('/remote/tmp/')).toBe(true)
    expect(writeFileBase64Mock).toHaveBeenCalled()
    expect(authorizeExternalPathMock).not.toHaveBeenCalled()
  })
})
