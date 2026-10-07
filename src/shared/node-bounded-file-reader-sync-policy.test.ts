import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as NodeFileSystem from 'node:fs'

const mocks = vi.hoisted(() => ({
  stat: vi.fn(),
  open: vi.fn(),
  fstat: vi.fn(),
  read: vi.fn(),
  close: vi.fn()
}))

vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof NodeFileSystem>()),
  statSync: mocks.stat,
  openSync: mocks.open,
  fstatSync: mocks.fstat,
  readSync: mocks.read,
  closeSync: mocks.close
}))

import { constants } from 'node:fs'
import { readNodeFileSyncWithinLimit } from './node-bounded-file-reader'

beforeEach(() => {
  vi.resetAllMocks()
  mocks.stat.mockReturnValue({ isFile: () => true })
  mocks.open.mockReturnValue(71)
  mocks.fstat.mockReturnValue({ size: 6, isFile: () => true })
})

describe('synchronous regular-file boundary', () => {
  it('rejects non-regular sources before opening them', () => {
    mocks.stat.mockReturnValue({ isFile: () => false })
    expect(() =>
      readNodeFileSyncWithinLimit('untrusted-source', 8, { regularFileOnly: true })
    ).toThrow('Expected a regular file')
    expect(mocks.open).not.toHaveBeenCalled()
  })

  it('rechecks the opened descriptor and closes it when the target changed', () => {
    mocks.fstat.mockReturnValue({ size: 0, isFile: () => false })
    expect(() =>
      readNodeFileSyncWithinLimit('replaced-source', 8, { regularFileOnly: true })
    ).toThrow('Expected a regular file')
    expect(mocks.open).toHaveBeenCalledWith(
      'replaced-source',
      constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NONBLOCK)
    )
    expect(mocks.read).not.toHaveBeenCalled()
    expect(mocks.close).toHaveBeenCalledWith(71)
  })

  it('rejects a truncated window instead of returning partial image bytes', () => {
    mocks.read.mockReturnValueOnce(2).mockReturnValueOnce(0)
    expect(() =>
      readNodeFileSyncWithinLimit('shrinking-source', 4, {
        regularFileOnly: true,
        window: { offset: 2, length: 4 }
      })
    ).toThrow('File is smaller than the requested window')
    expect(mocks.close).toHaveBeenCalledWith(71)
  })

  it('does not read beyond a selected extent when the source grows', () => {
    mocks.read.mockImplementation((_fd, buffer, offset, length, position) => {
      Buffer.from('0123456789').copy(buffer, offset, position, position + length)
      return length
    })
    const result = readNodeFileSyncWithinLimit('growing-source', 4, {
      window: { offset: 2, length: 4 }
    })
    expect(result.buffer.toString()).toBe('2345')
    expect(mocks.read).toHaveBeenCalledOnce()
    expect(mocks.close).toHaveBeenCalledWith(71)
  })
})
