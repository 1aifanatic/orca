import { MAX_FILE_RANGE_READ_BYTES } from '../../../../shared/file-range-read'
import { readRuntimeFileRange, statRuntimeReadTarget } from '@/runtime/runtime-file-range-client'
import type { CsvFilePreview } from './editor-csv-file-content'
import { CSV_RECORD_BYTES, type CsvIndex, type CsvPageRange } from './csv-byte-index'
import { CsvPreviewWorkerClient } from './csv-preview-worker-client'

export class CsvPagedPreview {
  private worker = new CsvPreviewWorkerClient()
  private cache = new Map<number, string[][]>()
  private canceled = false

  constructor(private readonly file: CsvFilePreview) {}

  async validateSnapshot(): Promise<void> {
    this.checkCanceled()
    const current = await statRuntimeReadTarget(this.file.readArgs)
    if (
      current.size !== this.file.snapshot.size ||
      current.mtime !== this.file.snapshot.mtime ||
      current.isDirectory
    ) {
      throw new Error('CSV changed on disk. Reload the file to refresh the preview.')
    }
    this.checkCanceled()
  }

  async read(start: number, end: number): Promise<Uint8Array<ArrayBuffer>> {
    this.checkCanceled()
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      end <= start ||
      end > this.file.snapshot.size ||
      end - start > CSV_RECORD_BYTES
    ) {
      throw new Error('Invalid CSV page range')
    }
    const bytes = new Uint8Array(end - start)
    let received = 0
    while (received < bytes.length) {
      this.checkCanceled()
      const chunk = await readRuntimeFileRange(
        this.file.readArgs,
        start + received,
        Math.min(MAX_FILE_RANGE_READ_BYTES, bytes.length - received)
      )
      this.checkCanceled()
      bytes.set(chunk, received)
      received += chunk.length
    }
    return bytes
  }

  async buildIndex(delimiter: string, onProgress: (bytes: number) => void): Promise<CsvIndex> {
    await this.validateSnapshot()
    await this.worker.request({ kind: 'init', delimiter })
    for (let offset = 0; offset < this.file.snapshot.size;) {
      const end = Math.min(this.file.snapshot.size, offset + MAX_FILE_RANGE_READ_BYTES)
      const bytes = await this.read(offset, end)
      await this.worker.request({ kind: 'feed', bytes })
      offset = end
      onProgress(offset)
    }
    await this.validateSnapshot()
    const value = await this.worker.request({ kind: 'finish' })
    if (value.kind !== 'index') {
      throw new Error('CSV worker did not return an index')
    }
    return value.index
  }

  async page(pageIndex: number, range: CsvPageRange): Promise<string[][]> {
    await this.validateSnapshot()
    const cached = this.cache.get(pageIndex)
    if (cached) {
      this.cache.delete(pageIndex)
      this.cache.set(pageIndex, cached)
      return cached
    }
    const bytes = await this.read(range.start, range.end)
    const value = await this.worker.request({ kind: 'parse', bytes, stripBom: range.start === 0 })
    if (value.kind !== 'rows' || value.rows.length !== range.rowCount) {
      throw new Error('CSV page boundary mismatch. Reload the preview.')
    }
    await this.validateSnapshot()
    this.cache.set(pageIndex, value.rows)
    while (this.cache.size > 4) {
      const first = this.cache.keys().next().value
      if (first !== undefined) {
        this.cache.delete(first)
      }
    }
    return value.rows
  }

  close(): void {
    this.canceled = true
    this.cache.clear()
    this.worker.close()
  }

  private checkCanceled(): void {
    if (this.canceled) {
      throw new Error('CSV preview was canceled')
    }
  }
}
