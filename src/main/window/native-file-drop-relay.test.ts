import type { BrowserWindow } from 'electron'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeFileDropPayload } from '../../shared/native-file-drop'
import type * as DragTempFileCopy from './dragged-temp-file-copy'
import type { DragTempCopyItemResult } from './dragged-temp-file-copy'

type IpcListener = (event: { sender: unknown }, payload: unknown) => void

const { materializeMock, sweepMock, ipcListeners } = vi.hoisted(() => ({
  materializeMock: vi.fn(),
  sweepMock: vi.fn(),
  ipcListeners: new Map<string, IpcListener>()
}))

vi.mock('electron', () => ({
  app: { getPath: () => '/app-temp' },
  ipcMain: {
    on: (channel: string, listener: IpcListener) => ipcListeners.set(channel, listener),
    removeListener: (channel: string, listener: IpcListener) => {
      if (ipcListeners.get(channel) === listener) {
        ipcListeners.delete(channel)
      }
    },
    removeAllListeners: (channel: string) => ipcListeners.delete(channel)
  }
}))

vi.mock('./dragged-temp-file-copy', async (importOriginal) => ({
  ...(await importOriginal<typeof DragTempFileCopy>()),
  materializeDragTempPaths: materializeMock,
  scheduleDragTempCopySweep: sweepMock
}))

vi.mock('./darwin-user-temp-dir', () => ({
  getDarwinUserTempDir: async () => '/private/var/folders/ab/xyz/T'
}))

import {
  createNativeFileDropQueue,
  DRAG_TEMP_COPY_TIMEOUT_REASON,
  registerFileDropRelay
} from './native-file-drop-relay'

const DRAG_TEMP = join('/', 'var', 'T', 'TemporaryItems', 'NSIRD_screencaptureui_1', 'Shot.png')
const COPY = join('/', 'var', 'T', 'orca-drops-501', 'orca-drop-abc123', 'Shot.png')
const FINDER = join('/', 'Users', 'me', 'Desktop', 'notes.txt')
const env = { platform: 'darwin' as const, sourceTempRoot: '/var/T', copyRoot: '/var/T/drops' }

function copied(sourcePath: string, destPath = sourcePath): DragTempCopyItemResult {
  return { sourcePath, status: 'imported', destPath }
}

function createQueue(
  overrides: {
    getCopyEnvironment?: () => Promise<typeof env>
    forward?: (payload: NativeFileDropPayload) => void
    copyTimeoutMs?: number
  } = {}
) {
  const forwarded: NativeFileDropPayload[] = []
  const controller = new AbortController()
  const enqueue = createNativeFileDropQueue({
    forward: overrides.forward ?? ((payload) => forwarded.push(payload)),
    platform: 'darwin',
    getCopyEnvironment: overrides.getCopyEnvironment ?? (async () => env),
    watchRenderer: () => ({ signal: controller.signal, dispose: () => undefined }),
    copyTimeoutMs: overrides.copyTimeoutMs
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
      getCopyEnvironment: async () => env,
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
      getCopyEnvironment: async () => {
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

  it('gives up on a hung copy, says why, and serves the drops behind it', async () => {
    let copySignal: AbortSignal | undefined
    materializeMock.mockImplementationOnce((_paths, _env, signal: AbortSignal) => {
      copySignal = signal
      return new Promise(() => undefined)
    })
    materializeMock.mockResolvedValueOnce([copied(FINDER)])
    const { enqueue, forwarded } = createQueue({ copyTimeoutMs: 5 })

    enqueue({ paths: [DRAG_TEMP], target: 'terminal' })
    enqueue({ paths: [FINDER], target: 'editor' })
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(copySignal?.aborted).toBe(true)
    expect(forwarded).toEqual([
      {
        byteLength: 0,
        pathCount: 1,
        reason: 'temp-copy-failed',
        target: 'rejected',
        commonReason: DRAG_TEMP_COPY_TIMEOUT_REASON
      },
      { paths: [FINDER], target: 'editor' }
    ])
  })

  it('does not report a copied drop as a failed copy when forwarding it throws', async () => {
    materializeMock.mockResolvedValueOnce([copied(DRAG_TEMP, COPY)])
    const forward = vi.fn((_payload: NativeFileDropPayload) => {
      throw new Error('send failed')
    })
    const { enqueue } = createQueue({ forward })

    enqueue({ paths: [DRAG_TEMP], target: 'terminal' })
    await settle()

    expect(forward.mock.calls).toEqual([[{ paths: [COPY], target: 'terminal' }]])
  })
})

const CHANNEL = 'terminal:file-dropped-from-preload'

function createWindow() {
  let destroyed = false
  const windowListeners = new Map<string, () => void>()
  const webContents = {
    isDestroyed: () => destroyed,
    send: vi.fn(),
    once: vi.fn(),
    removeListener: vi.fn()
  }
  const fake = {
    isDestroyed: () => destroyed,
    on: (event: string, listener: () => void) => windowListeners.set(event, listener),
    webContents
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the relay only touches the members stubbed above.
  const window = fake as unknown as BrowserWindow
  return {
    window,
    webContents,
    close: () => {
      destroyed = true
      windowListeners.get('closed')?.()
    },
    destroy: () => {
      destroyed = true
    }
  }
}

function relay(): IpcListener {
  const listener = ipcListeners.get(CHANNEL)
  expect(listener).toBeDefined()
  return listener!
}

describe('registerFileDropRelay', () => {
  beforeEach(() => {
    ipcListeners.clear()
    sweepMock.mockReset()
  })

  it('relays only well-formed drops from its own renderer, until the window closes', () => {
    const { window, webContents, close } = createWindow()
    registerFileDropRelay(window)
    const drop: NativeFileDropPayload = { paths: [FINDER], target: 'editor' }

    relay()({ sender: { id: 'other-window' } }, drop)
    relay()({ sender: webContents }, { paths: 'not-a-list', target: 'editor' })
    // Only main may report a failed copy; a renderer claiming one is ignored.
    relay()(
      { sender: webContents },
      { byteLength: 0, pathCount: 1, reason: 'temp-copy-failed', target: 'rejected' }
    )
    relay()({ sender: webContents }, drop)

    expect(webContents.send.mock.calls).toEqual([['terminal:file-drop', drop]])
    expect(sweepMock).toHaveBeenCalledTimes(1)
    close()
    expect(ipcListeners.has(CHANNEL)).toBe(false)
  })

  it('replaces a listener left by an earlier window', () => {
    const first = createWindow()
    const second = createWindow()
    registerFileDropRelay(first.window)
    registerFileDropRelay(second.window)

    relay()({ sender: first.webContents }, { paths: [FINDER], target: 'editor' })

    expect(first.webContents.send).not.toHaveBeenCalled()
  })

  it.skipIf(process.platform !== 'darwin')(
    'copies from the macOS user temp dir and sends nothing once the window is gone',
    async () => {
      const copy = deferred<DragTempCopyItemResult[]>()
      materializeMock.mockReturnValueOnce(copy.promise)
      const { window, webContents, destroy } = createWindow()
      registerFileDropRelay(window)

      relay()({ sender: webContents }, { paths: [DRAG_TEMP], target: 'terminal' })
      await settle()
      destroy()
      copy.resolve([copied(DRAG_TEMP, COPY)])
      await settle()

      expect(materializeMock.mock.calls[0][1]).toMatchObject({
        platform: 'darwin',
        sourceTempRoot: '/private/var/folders/ab/xyz/T'
      })
      expect(webContents.send).not.toHaveBeenCalled()
    }
  )
})
