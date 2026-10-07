import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ open: vi.fn(), stat: vi.fn() }))
vi.mock('node:fs/promises', () => ({ open: mocks.open, stat: mocks.stat }))

import { readNodeFileWithinLimit } from './node-bounded-file-reader'

function createHandle(content: string, onRead?: () => void) {
  const bytes = Buffer.from(content)
  return {
    stat: vi.fn().mockResolvedValue({ size: bytes.length, isFile: () => true }),
    close: vi.fn().mockResolvedValue(undefined),
    read: vi.fn(async (buffer: Buffer, offset: number, length: number, position: number) => {
      const count = Math.min(length, 2, Math.max(0, bytes.length - position))
      bytes.copy(buffer, offset, position, position + count)
      onRead?.()
      return { bytesRead: count }
    })
  }
}

beforeEach(() => {
  vi.resetAllMocks()
  mocks.stat.mockResolvedValue({ isFile: () => true })
})

describe('asynchronous window ownership', () => {
  it('captures the requested extent before the first asynchronous boundary', async () => {
    const handle = createHandle('abcdefgh')
    mocks.open.mockResolvedValue(handle)
    const window = { offset: 0, length: 4 }
    const result = readNodeFileWithinLimit('source', 4, { regularFileOnly: true, window })
    window.offset = 4
    expect((await result).buffer.toString()).toBe('abcd')
    expect(handle.close).toHaveBeenCalledOnce()
  })

  it('keeps partial reads inside the validated extent when the caller mutates its options', async () => {
    const window = { offset: 0, length: 4 }
    const handle = createHandle('abcdefgh', () => {
      window.offset = 4
    })
    mocks.open.mockResolvedValue(handle)
    expect((await readNodeFileWithinLimit('source', 4, { window })).buffer.toString()).toBe('abcd')
    expect(handle.read.mock.calls.map((call) => call[3])).toEqual([0, 2])
    expect(handle.close).toHaveBeenCalledOnce()
  })

  it('rejects truncation and closes the descriptor rather than returning partial bytes', async () => {
    const handle = createHandle('abcd')
    handle.stat.mockResolvedValue({ size: 6, isFile: () => true })
    mocks.open.mockResolvedValue(handle)
    await expect(
      readNodeFileWithinLimit('source', 4, { window: { offset: 2, length: 4 } })
    ).rejects.toThrow('File is smaller than the requested window')
    expect(handle.close).toHaveBeenCalledOnce()
  })

  it('honors cancellation between partial reads and closes the descriptor', async () => {
    const controller = new AbortController()
    const handle = createHandle('abcd', () => controller.abort())
    mocks.open.mockResolvedValue(handle)
    await expect(
      readNodeFileWithinLimit('source', 4, {
        signal: controller.signal,
        window: { offset: 0, length: 4 }
      })
    ).rejects.toThrow()
    expect(handle.read).toHaveBeenCalledOnce()
    expect(handle.close).toHaveBeenCalledOnce()
  })
})
