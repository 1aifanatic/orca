import { app, type BrowserWindow } from 'electron'
import { recordDurableCrashBreadcrumb } from '../crash-reporting/durable-crash-breadcrumb'

// Why: a renderer blocked in a sync GPU wait on a wedged GPU process never wakes
// (field: D3D11 exit 34, then a 0 MB GPU process and a 9-minute freeze), and the
// GPU's own watchdog lives in the stuck process. Killing it frees the renderer.
export const RENDERER_GPU_STALL_PING_INTERVAL_MS = 2_000
export const RENDERER_GPU_STALL_TIMEOUT_MS = 8_000
// Why: Chromium aborts the browser after repeated GPU deaths; never loop kills.
export const RENDERER_GPU_STALL_MAX_KILLS = 3
// Above this share of one core the renderer is busy in JS, not blocked on the GPU.
const BUSY_RENDERER_CPU_SHARE = 0.5

export type RendererGpuStallWatchdogDeps = {
  /** Resolves once the renderer main thread has run a task. */
  pingRenderer: () => Promise<unknown>
  /** False while loading, crashed, destroyed or paused in DevTools. */
  canPing: () => boolean
  /** Cumulative renderer CPU seconds, or null when unknown. */
  readRendererCpuSeconds: () => number | null
  readGpuPids: () => number[]
  killProcess: (pid: number) => void
  onGpuKilled: (info: { stalledMs: number; gpuPids: number[]; kills: number }) => void
  now?: () => number
}

type OutstandingPing = { startedAt: number; deadline: number; cpuSecondsAtStart: number | null }

export function createRendererGpuStallWatchdog(deps: RendererGpuStallWatchdogDeps): {
  tick: () => void
  /** Drops the outstanding ping; call when the renderer reloads or dies. */
  reset: () => void
} {
  const now = deps.now ?? Date.now
  let outstanding: OutstandingPing | null = null
  let lastTickAt: number | null = null
  let kills = 0

  const isBusyInJs = (ping: OutstandingPing, at: number): boolean => {
    const cpuSeconds = deps.readRendererCpuSeconds()
    if (cpuSeconds === null || ping.cpuSecondsAtStart === null) {
      return false
    }
    const share = ((cpuSeconds - ping.cpuSecondsAtStart) * 1_000) / Math.max(1, at - ping.startedAt)
    return share > BUSY_RENDERER_CPU_SHARE
  }

  const sendPing = (at: number): void => {
    const ping: OutstandingPing = {
      startedAt: at,
      deadline: at + RENDERER_GPU_STALL_TIMEOUT_MS,
      cpuSecondsAtStart: deps.readRendererCpuSeconds()
    }
    outstanding = ping
    const settle = (): void => {
      if (outstanding === ping) {
        outstanding = null
      }
    }
    deps.pingRenderer().then(settle, settle)
  }

  const tick = (): void => {
    const at = now()
    // Why: a tick gap means OS sleep froze both sides; an old ping proves nothing.
    const slept = lastTickAt !== null && at - lastTickAt > RENDERER_GPU_STALL_PING_INTERVAL_MS * 3
    lastTickAt = at
    if (slept || !deps.canPing()) {
      outstanding = null
      return
    }
    if (!outstanding) {
      sendPing(at)
      return
    }
    if (at < outstanding.deadline || kills >= RENDERER_GPU_STALL_MAX_KILLS) {
      return
    }
    if (isBusyInJs(outstanding, at)) {
      outstanding = null
      return
    }
    const gpuPids = deps.readGpuPids()
    if (gpuPids.length === 0) {
      sendPing(at)
      return
    }
    const stalledMs = at - outstanding.startedAt
    kills += 1
    for (const pid of gpuPids) {
      try {
        deps.killProcess(pid)
      } catch {
        // Already gone: Chromium relaunches the GPU process either way.
      }
    }
    deps.onGpuKilled({ stalledMs, gpuPids, kills })
    // Why a fresh ping: a wedged replacement GPU stalls it too, while a ping
    // that can never settle cannot keep re-triggering kills.
    sendPing(at)
  }

  const reset = (): void => {
    outstanding = null
  }

  return { tick, reset }
}

export function installRendererGpuStallWatchdog(mainWindow: BrowserWindow): () => void {
  const { webContents } = mainWindow
  const readRendererMetric = (): Electron.ProcessMetric | undefined => {
    const pid = webContents.getOSProcessId()
    return app.getAppMetrics().find((metric) => metric.pid === pid)
  }
  const watchdog = createRendererGpuStallWatchdog({
    pingRenderer: () => webContents.executeJavaScript('0'),
    canPing: () =>
      !mainWindow.isDestroyed() &&
      !webContents.isDestroyed() &&
      !webContents.isCrashed() &&
      !webContents.isLoadingMainFrame() &&
      !webContents.isDevToolsOpened(),
    readRendererCpuSeconds: () => readRendererMetric()?.cpu.cumulativeCPUUsage ?? null,
    readGpuPids: () =>
      app
        .getAppMetrics()
        .filter((metric) => metric.type === 'GPU')
        .map((metric) => metric.pid),
    killProcess: (pid) => process.kill(pid, 'SIGKILL'),
    onGpuKilled: (info) => {
      console.warn('[gpu] renderer stalled on GPU process; killed it to recover', info)
      recordDurableCrashBreadcrumb('renderer_gpu_stall_gpu_killed', {
        stalledMs: info.stalledMs,
        kills: info.kills
      })
    }
  })
  // Why: executeJavaScript never settles once its renderer reloads or crashes.
  webContents.on('did-start-loading', watchdog.reset)
  webContents.on('render-process-gone', watchdog.reset)
  const timer = setInterval(watchdog.tick, RENDERER_GPU_STALL_PING_INTERVAL_MS)
  timer.unref?.()
  return () => {
    clearInterval(timer)
    if (!webContents.isDestroyed()) {
      webContents.off('did-start-loading', watchdog.reset)
      webContents.off('render-process-gone', watchdog.reset)
    }
  }
}
