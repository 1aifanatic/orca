import { app, ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'
import { tmpdir } from 'node:os'
import {
  isNativeFileDropPayload,
  type NativeFileDropPayload,
  type NativeFileDropRejectedPayload
} from '../../shared/native-file-drop'
import { abortWhenRendererGone } from '../ipc/renderer-lifetime-abort'
import {
  getDragTempCopyRoot,
  materializeDragTempPaths,
  mayNeedDragTempCopy,
  scheduleDragTempCopySweep,
  type DragTempCopyEnvironment
} from './dragged-temp-file-copy'

type NativeFileDropQueueDeps = {
  forward: (payload: NativeFileDropPayload) => void
  platform: NodeJS.Platform
  getCopyEnvironment: () => DragTempCopyEnvironment
  watchRenderer: () => { signal: AbortSignal; dispose: () => void }
}

export function registerFileDropRelay(mainWindow: BrowserWindow): void {
  const channel = 'terminal:file-dropped-from-preload'
  const mainWebContents = mainWindow.webContents
  const isWindowGone = (): boolean => mainWindow.isDestroyed() || mainWebContents.isDestroyed()
  ipcMain.removeAllListeners(channel)
  const enqueue = createNativeFileDropQueue({
    // Why: one IPC event per drop gesture so the renderer gets the full path batch without timer-based reconstruction.
    forward: (payload) => {
      if (!isWindowGone()) {
        mainWebContents.send('terminal:file-drop', payload)
      }
    },
    platform: process.platform,
    getCopyEnvironment: () => ({
      platform: process.platform,
      sourceTempRoot: tmpdir(),
      copyRoot: getDragTempCopyRoot(app.getPath('temp'))
    }),
    watchRenderer: () => abortWhenRendererGone(mainWebContents)
  })
  const relayFileDrop = (event: Electron.IpcMainEvent, args: NativeFileDropPayload): void => {
    if (isWindowGone() || event.sender !== mainWebContents) {
      return
    }
    if (!isNativeFileDropPayload(args)) {
      return
    }
    enqueue(args)
  }
  ipcMain.on(channel, relayFileDrop)
  mainWindow.on('closed', () => {
    // Why: macOS keeps the process alive after window close; drop the closure so the destroyed window isn't retained.
    ipcMain.removeListener(channel, relayFileDrop)
  })
  scheduleDragTempCopySweep(() => getDragTempCopyRoot(app.getPath('temp')))
}

/**
 * Forward drops in arrival order. A drop holding a macOS drag-temp path waits
 * for main to copy it, because the PTY daemon cannot open the original; every
 * other drop is forwarded synchronously unless an earlier drop is still copying.
 * See docs/reference/macos-dropped-temp-file-materialization.md.
 */
export function createNativeFileDropQueue(
  deps: NativeFileDropQueueDeps
): (payload: NativeFileDropPayload) => void {
  let tail: Promise<void> | null = null
  return (payload) => {
    if (!tail && !needsDragTempCopy(payload, deps.platform)) {
      deps.forward(payload)
      return
    }
    // Why: never reject, or one failed drop would stall every drop queued behind it.
    const next = (tail ?? Promise.resolve())
      .then(() => copyAndForward(payload, deps))
      .catch(() => undefined)
    tail = next
    void next.then(() => {
      if (tail === next) {
        tail = null
      }
    })
  }
}

/** The payloads to forward for one drop: its prepared paths, then a rejection for any it lost. */
export async function prepareNativeFileDrop(
  payload: NativeFileDropPayload,
  env: DragTempCopyEnvironment,
  signal?: AbortSignal
): Promise<NativeFileDropPayload[]> {
  if (payload.target === 'rejected') {
    return [payload]
  }
  const results = await materializeDragTempPaths(payload.paths, env, signal)
  const paths = results.flatMap((result) => (result.status === 'imported' ? [result.destPath] : []))
  const unprepared = results.flatMap((result) => (result.status === 'imported' ? [] : [result]))
  const prepared: NativeFileDropPayload[] = paths.length > 0 ? [{ ...payload, paths }] : []
  if (unprepared.length > 0) {
    const commonReason = unprepared.every((item) => item.reason === unprepared[0].reason)
      ? unprepared[0].reason
      : undefined
    prepared.push(copyFailure(unprepared.length, commonReason))
  }
  return prepared
}

function needsDragTempCopy(payload: NativeFileDropPayload, platform: NodeJS.Platform): boolean {
  return (
    payload.target !== 'rejected' &&
    payload.paths.some((path) => mayNeedDragTempCopy(path, platform))
  )
}

async function copyAndForward(
  payload: NativeFileDropPayload,
  deps: NativeFileDropQueueDeps
): Promise<void> {
  const lifetime = deps.watchRenderer()
  try {
    for (const prepared of await prepareNativeFileDrop(
      payload,
      deps.getCopyEnvironment(),
      lifetime.signal
    )) {
      deps.forward(prepared)
    }
  } catch {
    // Why: an aborted drop has no renderer to report to; anything else must not vanish silently.
    if (!lifetime.signal.aborted && payload.target !== 'rejected') {
      deps.forward(copyFailure(payload.paths.length))
    }
  } finally {
    lifetime.dispose()
  }
}

function copyFailure(pathCount: number, commonReason?: string): NativeFileDropRejectedPayload {
  return {
    byteLength: 0,
    pathCount,
    reason: 'temp-copy-failed',
    target: 'rejected',
    ...(commonReason ? { commonReason } : {})
  }
}
