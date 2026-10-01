import { app, ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'
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
import { getDarwinUserTempDir } from './darwin-user-temp-dir'

// Why: drops are forwarded in order, so a hung copy must not hold every later drop forever.
const DRAG_TEMP_COPY_TIMEOUT_MS = 2 * 60 * 1000
export const DRAG_TEMP_COPY_TIMEOUT_REASON = 'Copying the dropped file took too long'

type RendererLifetime = { signal: AbortSignal; dispose: () => void }

type NativeFileDropQueueDeps = {
  forward: (payload: NativeFileDropPayload) => void
  platform: NodeJS.Platform
  getCopyEnvironment: () => Promise<DragTempCopyEnvironment>
  watchRenderer: () => RendererLifetime
  copyTimeoutMs?: number
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
    getCopyEnvironment: async () => ({
      platform: process.platform,
      sourceTempRoot: await getDarwinUserTempDir(),
      copyRoot: getDragTempCopyRoot(app.getPath('temp'))
    }),
    watchRenderer: () => abortWhenRendererGone(mainWebContents)
  })
  const relayFileDrop = (event: Electron.IpcMainEvent, args: NativeFileDropPayload): void => {
    if (isWindowGone() || event.sender !== mainWebContents) {
      return
    }
    // Why: only main reports a failed copy; a renderer claiming one is ignored.
    if (!isNativeFileDropPayload(args) || isTempCopyFailure(args)) {
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
    // Why: bind to the document that dropped now, so a reload while this waits discards it.
    const lifetime = deps.watchRenderer()
    // Why: never reject, or one failed drop would stall every drop queued behind it.
    const next = (tail ?? Promise.resolve())
      .then(() => copyAndForward(payload, lifetime, deps))
      .catch(() => undefined)
      .finally(lifetime.dispose)
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

function isTempCopyFailure(payload: NativeFileDropPayload): boolean {
  return payload.target === 'rejected' && payload.reason === 'temp-copy-failed'
}

function needsDragTempCopy(payload: NativeFileDropPayload, platform: NodeJS.Platform): boolean {
  return (
    payload.target !== 'rejected' &&
    payload.paths.some((path) => mayNeedDragTempCopy(path, platform))
  )
}

async function copyAndForward(
  payload: NativeFileDropPayload,
  lifetime: RendererLifetime,
  deps: NativeFileDropQueueDeps
): Promise<void> {
  if (lifetime.signal.aborted) {
    return
  }
  const timeout = new AbortController()
  const timer = setTimeout(
    () => timeout.abort(new Error(DRAG_TEMP_COPY_TIMEOUT_REASON)),
    deps.copyTimeoutMs ?? DRAG_TEMP_COPY_TIMEOUT_MS
  )
  const signal = AbortSignal.any([lifetime.signal, timeout.signal])
  let prepared: NativeFileDropPayload[]
  try {
    // Why: race the signal too, since a hung fs call never reaches the copy's abort checks.
    prepared = await rejectOnAbort(
      deps.getCopyEnvironment().then((env) => prepareNativeFileDrop(payload, env, signal)),
      signal
    )
  } catch {
    // Why: an aborted drop has no renderer to report to; anything else must not vanish silently.
    if (!lifetime.signal.aborted && payload.target !== 'rejected') {
      const reason = timeout.signal.aborted ? DRAG_TEMP_COPY_TIMEOUT_REASON : undefined
      deps.forward(copyFailure(payload.paths.length, reason))
    }
    return
  } finally {
    clearTimeout(timer)
  }
  // Why: outside the try, so a failed forward is not reported a second time as a failed copy.
  for (const item of prepared) {
    deps.forward(item)
  }
}

function rejectOnAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason)
    if (signal.aborted) {
      onAbort()
    } else {
      signal.addEventListener('abort', onAbort, { once: true })
    }
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
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
