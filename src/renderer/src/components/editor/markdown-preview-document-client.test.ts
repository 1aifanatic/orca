import { afterEach, describe, expect, it, vi } from 'vitest'
import { MarkdownPreviewDocumentClient } from './markdown-preview-document-client'
import {
  MARKDOWN_PREVIEW_WORKER_TIMEOUT_MS,
  type MarkdownPreviewWorkerResult
} from './markdown-preview-document-types'

class WorkerTransport extends EventTarget implements Worker {
  onmessage: Worker['onmessage'] = null
  onerror: Worker['onerror'] = null
  onmessageerror: Worker['onmessageerror'] = null
  postMessage = vi.fn<(message: unknown) => void>()
  terminate = vi.fn()
  reply(result: MarkdownPreviewWorkerResult): void {
    this.onmessage?.(new MessageEvent('message', { data: result }))
  }
}

afterEach(() => vi.useRealTimers())
describe('Markdown preview worker ownership', () => {
  it('drops superseded replies and retains one pending request per kind', async () => {
    const worker = new WorkerTransport()
    const failure = vi.fn()
    const client = new MarkdownPreviewDocumentClient(worker, failure)
    const old = client.request({ type: 'blocks', indices: [0] }).catch((error) => error)
    const current = client.request({ type: 'blocks', indices: [20] })
    worker.reply({ id: 1, type: 'blocks', blocks: [] })
    worker.reply({
      id: 2,
      type: 'blocks',
      blocks: [{ index: 20, tree: { type: 'root', children: [] }, oversized: false }]
    })
    expect(await old).toBeInstanceOf(Error)
    expect(await current).toMatchObject({ id: 2, blocks: [{ index: 20 }] })
    expect(failure).not.toHaveBeenCalled()
    client.close()
    expect(worker.terminate).toHaveBeenCalledOnce()
    expect(worker.onmessage).toBeNull()
  })
  it('terminates stalled work and rejects every pending owner', async () => {
    vi.useFakeTimers()
    const worker = new WorkerTransport()
    const failure = vi.fn()
    const client = new MarkdownPreviewDocumentClient(worker, failure)
    const load = client.request({ type: 'load', content: '# Heading' }).catch((error) => error)
    const search = client.request({ type: 'search', query: 'heading' }).catch((error) => error)
    await vi.advanceTimersByTimeAsync(MARKDOWN_PREVIEW_WORKER_TIMEOUT_MS)
    expect(await load).toBeInstanceOf(Error)
    expect(await search).toBeInstanceOf(Error)
    expect(worker.terminate).toHaveBeenCalledOnce()
    expect(failure).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
    expect(
      await client.request({ type: 'blocks', indices: [] }).catch((error) => error)
    ).toBeInstanceOf(Error)
  })
  it('closes on parse errors without a synchronous retry', async () => {
    const worker = new WorkerTransport()
    const failure = vi.fn()
    const client = new MarkdownPreviewDocumentClient(worker, failure)
    const load = client.request({ type: 'load', content: '# Heading' }).catch((error) => error)
    worker.reply({ id: 1, type: 'error', message: 'Too complex' })
    expect(await load).toBeInstanceOf(Error)
    expect(failure).toHaveBeenCalledWith(expect.objectContaining({ message: 'Too complex' }))
    expect(worker.terminate).toHaveBeenCalledOnce()
  })
  it('cleans up requests on content replacement or tab close', async () => {
    vi.useFakeTimers()
    const worker = new WorkerTransport()
    const failure = vi.fn()
    const client = new MarkdownPreviewDocumentClient(worker, failure)
    const pending = client.request({ type: 'search', query: 'text' }).catch((error) => error)
    client.close()
    client.close()
    expect(await pending).toBeInstanceOf(Error)
    expect(worker.terminate).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
    expect(failure).not.toHaveBeenCalled()
  })
})
