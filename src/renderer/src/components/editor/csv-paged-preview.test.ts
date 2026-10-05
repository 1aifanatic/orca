import { beforeEach, expect, it, vi } from 'vitest'
import { CsvPagedPreview } from './csv-paged-preview'

const mocks = vi.hoisted(() => ({ stat: vi.fn(), read: vi.fn(), request: vi.fn(), close: vi.fn() }))
vi.mock('@/runtime/runtime-file-range-client', () => ({
  statRuntimeReadTarget: mocks.stat,
  readRuntimeFileRange: mocks.read
}))
vi.mock('./csv-preview-worker-client', () => ({
  CsvPreviewWorkerClient: class {
    request = mocks.request
    close = mocks.close
  }
}))

const snapshot = { size: 1024 * 1024, mtime: 1, isDirectory: false }
const file = { readArgs: { settings: null, filePath: '/repo/a.csv' }, snapshot }
beforeEach(() => {
  vi.resetAllMocks()
  mocks.stat.mockResolvedValue(snapshot)
  mocks.read.mockImplementation(async (_args, _offset, length: number) => new Uint8Array(length))
  mocks.request.mockResolvedValue({ kind: 'rows', rows: [['value']] })
})

it('retains four pages and evicts the least recently used one', async () => {
  const preview = new CsvPagedPreview(file)
  const range = (index: number) => ({
    start: index * 10,
    end: index * 10 + 10,
    firstRow: index,
    rowCount: 1
  })
  for (let index = 0; index < 4; index += 1) {
    await preview.page(index, range(index))
  }
  await preview.page(0, range(0))
  await preview.page(4, range(4))
  await preview.page(1, range(1))
  expect(mocks.read).toHaveBeenCalledTimes(6)
  preview.close()
})

it('detects changes even when a page is already cached', async () => {
  const preview = new CsvPagedPreview(file)
  const range = { start: 0, end: 10, firstRow: 0, rowCount: 1 }
  await preview.page(0, range)
  mocks.stat.mockResolvedValue({ ...snapshot, mtime: 2 })
  await expect(preview.page(0, range)).rejects.toThrow('changed on disk')
  expect(mocks.read).toHaveBeenCalledTimes(1)
  preview.close()
})

it('bounds reads, stops after cancellation, and rejects mismatched pages', async () => {
  const preview = new CsvPagedPreview(file)
  await preview.read(0, 1024 * 1024)
  expect(mocks.read.mock.calls.map((call) => call[2])).toEqual(
    Array.from({ length: 4 }, () => 256 * 1024)
  )
  await expect(preview.read(-1, 1)).rejects.toThrow('Invalid CSV page range')
  await expect(preview.page(0, { start: 0, end: 10, firstRow: 0, rowCount: 2 })).rejects.toThrow(
    'boundary mismatch'
  )
  preview.close()
  await expect(preview.read(0, 10)).rejects.toThrow('canceled')
  expect(mocks.close).toHaveBeenCalledTimes(1)
})

it('detects a mutation during the full scan before publishing an index', async () => {
  const preview = new CsvPagedPreview(file)
  mocks.request.mockResolvedValue({ kind: 'ack' })
  mocks.stat.mockResolvedValueOnce(snapshot).mockResolvedValue({ ...snapshot, size: 20 })
  await expect(preview.buildIndex(',', () => {})).rejects.toThrow('changed on disk')
  expect(mocks.request.mock.calls.some(([command]) => command.kind === 'finish')).toBe(false)
  preview.close()
})
