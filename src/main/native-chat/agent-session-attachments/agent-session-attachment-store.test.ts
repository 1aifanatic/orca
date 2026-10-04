import { mkdtemp, readdir, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentSessionAttachmentStore } from './agent-session-attachment-store'

let root: string
let store: AgentSessionAttachmentStore
const caller = 'client-a'

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-attachments-'))
  store = new AgentSessionAttachmentStore(join(root, 'agent-session-attachments'))
})

afterEach(async () => {
  store.clearInFlightForTests()
  vi.useRealTimers()
  await rm(root, { recursive: true, force: true })
})

async function upload(name: string, bytes: Buffer, sessionId = 'session-1') {
  const { uploadId } = await store.startUpload({
    callerKey: caller,
    sessionId,
    name,
    byteLength: bytes.byteLength
  })
  await store.appendChunk({
    callerKey: caller,
    uploadId,
    offset: 0,
    contentBase64: bytes.toString('base64')
  })
  return store.commitUpload({ callerKey: caller, uploadId })
}

describe('AgentSessionAttachmentStore', () => {
  it('stores the bytes under the chat, keeping the file name', async () => {
    const stored = await upload('screen shot.png', Buffer.from('png-bytes'))
    expect(stored.name).toBe('screen shot.png')
    expect(stored.byteLength).toBe(9)
    expect(stored.path.startsWith(store.sessionDirectory('session-1'))).toBe(true)
    expect(stored.path.endsWith('screen shot.png')).toBe(true)
    expect(await readFile(stored.path, 'utf8')).toBe('png-bytes')
    // The part file is gone once the name holds the whole file.
    expect(await readdir(join(stored.path, '..'))).toEqual(['screen shot.png'])
  })

  it('keeps only the last path segment of a name, never a path out of the store', async () => {
    const stored = await upload('../../../etc/passwd', Buffer.from('x'))
    expect(stored.name).toBe('passwd')
    expect(stored.path.startsWith(store.sessionDirectory('session-1'))).toBe(true)
  })

  it('appends chunks in order and refuses one out of order or past the declared size', async () => {
    const { uploadId } = await store.startUpload({
      callerKey: caller,
      sessionId: 'session-1',
      name: 'a.txt',
      byteLength: 4
    })
    const chunk = (text: string) => Buffer.from(text).toString('base64')
    await store.appendChunk({ callerKey: caller, uploadId, offset: 0, contentBase64: chunk('ab') })
    await expect(
      store.appendChunk({ callerKey: caller, uploadId, offset: 0, contentBase64: chunk('cd') })
    ).rejects.toThrow('out of order')
    await expect(
      store.appendChunk({ callerKey: caller, uploadId, offset: 2, contentBase64: chunk('cde') })
    ).rejects.toThrow('exceeded its declared size')
    await store.appendChunk({ callerKey: caller, uploadId, offset: 2, contentBase64: chunk('cd') })
    const stored = await store.commitUpload({ callerKey: caller, uploadId })
    expect(await readFile(stored.path, 'utf8')).toBe('abcd')
  })

  it('refuses an incomplete commit and removes what it had', async () => {
    const { uploadId } = await store.startUpload({
      callerKey: caller,
      sessionId: 'session-1',
      name: 'a.txt',
      byteLength: 10
    })
    await expect(store.commitUpload({ callerKey: caller, uploadId })).rejects.toThrow('incomplete')
    expect(await readdir(store.sessionDirectory('session-1'))).toEqual([])
  })

  it('stores an empty file', async () => {
    const stored = await upload('empty.txt', Buffer.alloc(0))
    expect((await stat(stored.path)).size).toBe(0)
  })

  it('does not let another client touch an upload it did not start', async () => {
    const { uploadId } = await store.startUpload({
      callerKey: caller,
      sessionId: 'session-1',
      name: 'a.txt',
      byteLength: 1
    })
    await expect(
      store.appendChunk({ callerKey: 'client-b', uploadId, offset: 0, contentBase64: 'eA==' })
    ).rejects.toThrow('not found')
    await expect(store.commitUpload({ callerKey: 'client-b', uploadId })).rejects.toThrow(
      'not found'
    )
    await expect(store.abortUpload({ callerKey: 'client-b', uploadId })).rejects.toThrow(
      'not found'
    )
    expect(store.isUploadInFlight(uploadId)).toBe(true)
  })

  it('removes an aborted upload', async () => {
    const { uploadId } = await store.startUpload({
      callerKey: caller,
      sessionId: 'session-1',
      name: 'a.txt',
      byteLength: 1
    })
    await store.abortUpload({ callerKey: caller, uploadId })
    expect(store.isUploadInFlight(uploadId)).toBe(false)
    expect(await readdir(store.sessionDirectory('session-1'))).toEqual([])
  })

  it('forgets and removes an upload its client abandoned', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const { uploadId } = await store.startUpload({
      callerKey: caller,
      sessionId: 'session-1',
      name: 'a.txt',
      byteLength: 1
    })
    vi.advanceTimersByTime(5 * 60 * 1000 + 1)
    vi.useRealTimers()
    await vi.waitFor(async () =>
      expect(await readdir(store.sessionDirectory('session-1'))).toEqual([])
    )
    expect(store.isUploadInFlight(uploadId)).toBe(false)
    await expect(store.commitUpload({ callerKey: caller, uploadId })).rejects.toThrow('not found')
  })

  it('reads back a stored image and nothing outside the store', async () => {
    const stored = await upload('shot.png', Buffer.from('png-bytes'))
    await expect(store.readPreview(stored.path)).resolves.toEqual({
      content: Buffer.from('png-bytes').toString('base64'),
      isBinary: true,
      isImage: true,
      mimeType: 'image/png'
    })
    const outside = join(root, 'outside.png')
    await writeFile(outside, 'secret')
    await expect(store.readPreview(outside)).rejects.toThrow('Not an attachment image')
    const notImage = await upload('notes.txt', Buffer.from('text'))
    await expect(store.readPreview(notImage.path)).rejects.toThrow('Not an attachment image')
  })

  it('reads only a file exactly at <chat>/<upload>/<name>', async () => {
    const { uploadId } = await store.startUpload({
      callerKey: caller,
      sessionId: 'session-1',
      name: 'shot.png',
      byteLength: 3
    })
    const uploadDir = join(store.sessionDirectory('session-1'), uploadId)
    // Deeper than a stored file: nothing the store wrote lives there.
    await mkdir(join(uploadDir, 'nested'), { recursive: true })
    await writeFile(join(uploadDir, 'nested', 'x.png'), 'x')
    await expect(store.readPreview(join(uploadDir, 'nested', 'x.png'))).rejects.toThrow(
      'Not an attachment image'
    )
  })
})
