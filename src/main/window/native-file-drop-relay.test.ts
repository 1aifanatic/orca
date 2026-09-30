import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeFileDropPayload } from '../../shared/native-file-drop'
import type * as DragTempFileCopy from './dragged-temp-file-copy'
import type { DragTempCopyItemResult } from './dragged-temp-file-copy'

const { materializeMock } = vi.hoisted(() => ({ materializeMock: vi.fn() }))

vi.mock('electron', () => ({ app: {}, ipcMain: {} }))

vi.mock('./dragged-temp-file-copy', async (importOriginal) => ({
  ...(await importOriginal<typeof DragTempFileCopy>()),
  materializeDragTempPaths: materializeMock
}))

import { createNativeFileDropQueue } from './native-file-drop-relay'

const DRAG_TEMP = join('/', 'var', 'T', 'TemporaryItems', 'NSIRD_screencaptureui_1', 'Shot.png')
const COPY = join('/', 'var', 'T', 'orca-drops-501', 'orca-drop-abc123', 'Shot.png')
const FINDER = join('/', 'Users', 'me', 'Desktop', 'notes.txt')
const env = { platform: 'darwin' as const, sourceTempRoot: '/var/T', copyRoot: '/var/T/drops' }

function copied(sourcePath: string, destPath = sourcePath): DragTempCopyItemResult {
  return { sourcePath, status: 'imported', destPath }
}

function createQueue(overrides: { getCopyEnvironment?: () => typeof env } = {}) {
  const forwarded: NativeFileDropPayload[] = []
  const controller = new AbortController()
  const enqueue = createNativeFileDropQueue({
    forward: (payload) => forwarded.push(payload),
    platform: 'darwin',
    getCopyEnvironment: overrides.getCopyEnvironment ?? (() => env),
    watchRenderer: () => ({ signal: controller.signal, dispose: () => undefined })
  })
  return { enqueue, forwarded, controller }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(() => {
  materializeMock.mockReset()
})

describe('createNativeFileDropQueue', () => {
  it('forwards a drop with no drag-temp path synchronously without copying', () => {
    const { enqueue, forwarded } = createQueue()
    const payload: NativeFileDropPayload = { paths: [FINDER], target: 'editor' }

    enqueue(payload)

    expect(forwarded).toEqual([payload])
    expect(materializeMock).not.toHaveBeenCalled()
  })

  it('forwards drag-temp-looking paths untouched off macOS', () => {
    const forwarded: NativeFileDropPayload[] = []
    const enqueue = createNativeFileDropQueue({
      forward: (payload) => forwarded.push(payload),
      platform: 'linux',
      getCopyEnvironment: () => env,
      watchRenderer: () => ({ signal: new AbortController().signal, dispose: () => undefined })
    })

    enqueue({ paths: [DRAG_TEMP], target: 'composer' })

    expect(forwarded).toEqual([{ paths: [DRAG_TEMP], target: 'composer' }])
    expect(materializeMock).not.toHaveBeenCalled()
  })

  it('swaps in the copy and keeps the drop target fields', async () => {
    materializeMock.mockResolvedValue([copied(FINDER), copied(DRAG_TEMP, COPY)])
    const { enqueue, forwarded } = createQueue()

    enqueue({ paths: [FINDER, DRAG_TEMP], target: 'terminal', tabId: 't1', paneLeafId: 'p1' })
    await settle()

    expect(materializeMock).toHaveBeenCalledWith([FINDER, DRAG_TEMP], env, expect.any(AbortSignal))
    expect(forwarded).toEqual([
      { paths: [FINDER, COPY], target: 'terminal', tabId: 't1', paneLeafId: 'p1' }
    ])
  })

  it('holds a later plain drop until an earlier copy finishes', async () => {
    const copy = deferred<DragTempCopyItemResult[]>()
    materializeMock
      .mockReturnValueOnce(copy.promise)
      .mockImplementation(async (paths: string[]) => paths.map((path) => copied(path)))
    const { enqueue, forwarded } = createQueue()

    enqueue({ paths: [DRAG_TEMP], target: 'composer' })
    enqueue({ paths: [FINDER], target: 'editor' })
    await settle()
    expect(forwarded).toEqual([])

    copy.resolve([copied(DRAG_TEMP, COPY)])
    await settle()

    expect(forwarded).toEqual([
      { paths: [COPY], target: 'composer' },
      { paths: [FINDER], target: 'editor' }
    ])
  })

  it('forwards what it could copy and reports the rest with their shared reason', async () => {
    const other = join('/', 'var', 'T', 'TemporaryItems', 'NSIRD_screencaptureui_1', 'Other.png')
    materializeMock.mockResolvedValue([
      copied(DRAG_TEMP, COPY),
      { sourcePath: other, status: 'skipped', reason: 'permission-denied' }
    ])
    const { enqueue, forwarded } = createQueue()

    enqueue({ paths: [DRAG_TEMP, other], target: 'composer', scopeKey: 'pane-1' })
    await settle()

    expect(forwarded).toEqual([
      { paths: [COPY], target: 'composer', scopeKey: 'pane-1' },
      {
        byteLength: 0,
        pathCount: 1,
        reason: 'temp-copy-failed',
        target: 'rejected',
        commonReason: 'permission-denied'
      }
    ])
  })

  it('reports a drop that lost every file, with no shared reason when they differ', async () => {
    materializeMock.mockResolvedValue([
      { sourcePath: DRAG_TEMP, status: 'skipped', reason: 'missing' },
      { sourcePath: DRAG_TEMP, status: 'failed', reason: 'File changed while it was being copied' }
    ])
    const { enqueue, forwarded } = createQueue()

    enqueue({ paths: [DRAG_TEMP, DRAG_TEMP], target: 'terminal' })
    await settle()

    expect(forwarded).toEqual([
      { byteLength: 0, pathCount: 2, reason: 'temp-copy-failed', target: 'rejected' }
    ])
  })

  it('drops a copy whose renderer went away, and keeps serving later drops', async () => {
    const { enqueue, forwarded, controller } = createQueue()
    materializeMock.mockImplementationOnce(async () => {
      controller.abort(new Error('renderer gone'))
      throw new Error('renderer gone')
    })

    enqueue({ paths: [DRAG_TEMP], target: 'terminal' })
    await settle()
    enqueue({ paths: [FINDER], target: 'editor' })

    expect(forwarded).toEqual([{ paths: [FINDER], target: 'editor' }])
  })

  it('reports an unexpected copy error for the whole drop instead of dropping it silently', async () => {
    const { enqueue, forwarded } = createQueue({
      getCopyEnvironment: () => {
        throw new Error('no temp path')
      }
    })

    enqueue({ paths: [FINDER, DRAG_TEMP], target: 'composer' })
    await settle()
    enqueue({ paths: [FINDER], target: 'editor' })

    expect(forwarded).toEqual([
      { byteLength: 0, pathCount: 2, reason: 'temp-copy-failed', target: 'rejected' },
      { paths: [FINDER], target: 'editor' }
    ])
  })

  it('passes a rejected drop through in order behind a pending copy', async () => {
    const copy = deferred<DragTempCopyItemResult[]>()
    materializeMock.mockReturnValueOnce(copy.promise)
    const { enqueue, forwarded } = createQueue()
    const rejected: NativeFileDropPayload = {
      byteLength: 0,
      pathCount: 300,
      reason: 'too-many-paths',
      target: 'rejected'
    }

    enqueue({ paths: [DRAG_TEMP], target: 'terminal' })
    enqueue(rejected)
    copy.resolve([copied(DRAG_TEMP, COPY)])
    await settle()

    expect(forwarded).toEqual([{ paths: [COPY], target: 'terminal' }, rejected])
  })
})
