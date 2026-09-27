import { copyFile } from 'node:fs/promises'
import { test as base, expect } from './helpers/orca-app'
import { presentSidebarMotionWindow } from './sidebar-motion-presentation'

export { expect }

export const test = base.extend<{ sidebarAnimationFrames: void }>({
  orcaAppExtraEnv: { ORCA_BACKGROUND_LAUNCH: '1' },
  orcaAppExtraArgs: [
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding'
  ],
  sidebarAnimationFrames: [
    async ({ electronApp, orcaPage }, provideFixture, testInfo) => {
      const windowGuard = await electronApp.evaluateHandle(({ app, BrowserWindow }) => {
        let showEvents = 0
        let focusEvents = 0
        const onShow = () => showEvents++
        const onFocus = () => focusEvents++
        const windows = new Set<Electron.BrowserWindow>()
        const watch = (window: Electron.BrowserWindow) => {
          windows.add(window)
          if (window.isVisible()) {
            onShow()
          }
          if (window.isFocused()) {
            onFocus()
          }
          window.on('show', onShow)
          window.on('focus', onFocus)
        }
        const onCreated = (_event: Electron.Event, window: Electron.BrowserWindow) => watch(window)
        app.on('browser-window-created', onCreated)
        BrowserWindow.getAllWindows().forEach(watch)
        return {
          finish() {
            app.off('browser-window-created', onCreated)
            for (const window of windows) {
              window.off('show', onShow)
              window.off('focus', onFocus)
            }
            return {
              showEvents,
              focusEvents,
              hidden: BrowserWindow.getAllWindows().every(
                (window) => !window.isVisible() && !window.isFocused()
              )
            }
          }
        }
      })
      let frames = 0
      let acknowledged = 0
      const ackErrors: string[] = []
      const screencastFrames: {
        metadataTimestampMs: number | null
        hostMonotonicMs: number
        hostWallMs: number
        acknowledgedMonotonicMs: number | null
      }[] = []
      const failures: { stage: string; error: unknown }[] = []
      const attempt = async (stage: string, operation: () => Promise<unknown>) => {
        try {
          await operation()
        } catch (error) {
          failures.push({ stage, error })
        }
      }
      const frameSamples: { phase: string; elapsedMs: number[]; epochMs: number[]; timedOut: boolean }[] = []
      const caseId = process.env.ORCA_E2E_SIDEBAR_CASE ?? null
      const arm = process.env.ORCA_E2E_SIDEBAR_MOTION_XVFB === '1' ? 'mapped' : 'hidden'
      const traceRequested = process.env.ORCA_E2E_SIDEBAR_TRACE === '1'
      const clockCalibration = {
        hostMonotonicMs: Number(process.hrtime.bigint()) / 1_000_000,
        hostWallMs: Date.now(),
        hostEpochMinusMonotonicMs: Date.now() - Number(process.hrtime.bigint()) / 1_000_000
      }
      let presentation: { presented: boolean; windows: number; visible: number; display: string | null } = {
        presented: false,
        windows: 0,
        visible: 0,
        display: null
      }
      let referenceChannels: unknown = null
      let traceEvidence: {
        requested: boolean
        started: boolean
        stopped: boolean
        startEpochMs: number | null
        stopEpochMs: number | null
        durationMs: number | null
        pageTimeOriginMs: number | null
        startMarkPageMs: number | null
        stopMarkPageMs: number | null
        savedPath: string | null
        error: string | null
      } = {
        requested: traceRequested,
        started: false,
        stopped: false,
        startEpochMs: null,
        stopEpochMs: null,
        durationMs: null,
        pageTimeOriginMs: null,
        startMarkPageMs: null,
        stopMarkPageMs: null,
        savedPath: null,
        error: null
      }
      const sampleFrames = async (phase: string) => {
        const sample = await orcaPage.evaluate(
          () =>
            new Promise<{
              elapsedMs: number[]
              epochMs: number[]
              timedOut: boolean
            }>((resolve) => {
              const elapsedMs: number[] = []
              const epochMs: number[] = []
              const started = performance.now()
              let frame = 0
              const timeout = setTimeout(() => {
                cancelAnimationFrame(frame)
                resolve({ elapsedMs, epochMs, timedOut: true })
              }, 5000)
              const tick = () => {
                const now = performance.now()
                elapsedMs.push(now - started)
                epochMs.push(performance.timeOrigin + now)
                if (elapsedMs.length === 3) {
                  clearTimeout(timeout)
                  resolve({ elapsedMs, epochMs, timedOut: false })
                } else {
                  frame = requestAnimationFrame(tick)
                }
              }
              frame = requestAnimationFrame(tick)
            })
        )
        frameSamples.push({ phase, ...sample })
        expect(sample.timedOut, 'native animation frame sampling timed out').toBe(false)
        // Allow loaded CI frames, but reject Chromium's roughly one-second hidden-frame cadence.
        const gaps = sample.elapsedMs.map(
          (time, index) => time - (sample.elapsedMs[index - 1] ?? 0)
        )
        expect(Math.max(...gaps), 'native animation frame gap').toBeLessThan(500)
      }
      await attempt('capture', async () => {
        await electronApp.evaluate(({ BrowserWindow }) => {
          BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(false)
        })
        const cdp = await orcaPage.context().newCDPSession(orcaPage)
        const pending = new Set<Promise<void>>()
        const onFrame = ({
          sessionId,
          metadata
        }: {
          sessionId: number
          metadata?: { timestamp?: number }
        }) => {
          frames++
          const frame = {
            metadataTimestampMs:
              typeof metadata?.timestamp === 'number' ? metadata.timestamp * 1000 : null,
            hostMonotonicMs: Number(process.hrtime.bigint()) / 1_000_000,
            hostWallMs: Date.now(),
            acknowledgedMonotonicMs: null as number | null
          }
          screencastFrames.push(frame)
          const ack = cdp.send('Page.screencastFrameAck', { sessionId }).then(
            () => {
              acknowledged++
              frame.acknowledgedMonotonicMs = Number(process.hrtime.bigint()) / 1_000_000
            },
            (error: unknown) => {
              if (ackErrors.length < 3) {
                ackErrors.push(String(error))
              }
            }
          )
          pending.add(ack)
          void ack.finally(() => pending.delete(ack))
        }
        try {
          await orcaPage.setViewportSize({ width: 1280, height: 1024 })
          presentation = await presentSidebarMotionWindow(electronApp, testInfo)
          // Diagnostic-only channels: never read by any gate, only used to separate
          // a blocked main thread from undelivered frames after the fact.
          await orcaPage.evaluate(() => {
            const origin = performance.now()
            const ticks50: number[] = []
            const ticks16: number[] = []
            const rafFrames: number[] = []
            const longTasks: { startTime: number; duration: number }[] = []
            const timer50 = setInterval(() => ticks50.push(performance.now() - origin), 50)
            const timer16 = setInterval(() => ticks16.push(performance.now() - origin), 16)
            let frame = requestAnimationFrame(function tick() {
              rafFrames.push(performance.now() - origin)
              frame = requestAnimationFrame(tick)
            })
            const observer = new PerformanceObserver((list) => {
              for (const entry of list.getEntries()) {
                longTasks.push({ startTime: entry.startTime - origin, duration: entry.duration })
              }
            })
            observer.observe({ type: 'longtask', buffered: true })
            Object.assign(window, {
              __orcaFrameDiagnostics: {
                finish() {
                  clearInterval(timer50)
                  clearInterval(timer16)
                  cancelAnimationFrame(frame)
                  observer.disconnect()
                  return {
                    originPageMs: origin,
                    pageTimeOriginMs: performance.timeOrigin,
                    originEpochMs: performance.timeOrigin + origin,
                    ticks50,
                    ticks16,
                    rafFrames,
                    longTasks,
                    visibility: { state: document.visibilityState, hidden: document.hidden }
                  }
                }
              }
            })
          })
          cdp.on('Page.screencastFrame', onFrame)
          await cdp.send('Page.enable')
          // Consume compositor output to test Chromium's hidden undrawn-frame throttle.
          await cdp.send('Page.startScreencast', {
            format: 'jpeg',
            quality: 10,
            maxWidth: 160,
            maxHeight: 128,
            everyNthFrame: 1
          })
          await sampleFrames('before')
          if (traceRequested) {
            await attempt('start chromium trace', async () => {
              await electronApp.evaluate(({ contentTracing }) =>
                contentTracing.startRecording({
                  included_categories: ['viz', 'cc', 'toplevel', 'blink.user_timing']
                })
              )
              traceEvidence.started = true
              traceEvidence.startEpochMs = Date.now()
              const marks = await orcaPage.evaluate(() => {
                performance.mark('orca-sidebar-frame-capture-start')
                return { pageMs: performance.now(), timeOriginMs: performance.timeOrigin }
              })
              traceEvidence.startMarkPageMs = marks.pageMs
              traceEvidence.pageTimeOriginMs = marks.timeOriginMs
            })
          }
          await provideFixture()
          if (traceEvidence.started) {
            await attempt('stop chromium trace', async () => {
              traceEvidence.stopMarkPageMs = await orcaPage.evaluate(() => {
                performance.mark('orca-sidebar-frame-capture-end')
                return performance.now()
              })
              const recorded = await electronApp.evaluate(({ contentTracing }) =>
                contentTracing.stopRecording()
              )
              traceEvidence.stopped = true
              traceEvidence.stopEpochMs = Date.now()
              traceEvidence.durationMs = traceEvidence.stopEpochMs - (traceEvidence.startEpochMs ?? traceEvidence.stopEpochMs)
              const destination = testInfo.outputPath('chromium-trace.json')
              await copyFile(recorded, destination)
              traceEvidence.savedPath = destination
            })
          }
          await attempt('read reference channels', async () => {
            referenceChannels = await orcaPage.evaluate(
              () =>
                (
                  window as unknown as {
                    __orcaFrameDiagnostics?: { finish: () => unknown }
                  }
                ).__orcaFrameDiagnostics?.finish() ?? null
            )
          })
          await sampleFrames('after')
        } catch (error) {
          failures.push({ stage: 'sampling or test', error })
        } finally {
          await attempt('stop capture', () => cdp.send('Page.stopScreencast'))
          cdp.off('Page.screencastFrame', onFrame)
          await attempt('drain acknowledgements', () => Promise.all(pending))
          await attempt('detach capture', () => cdp.detach())
        }
      })
      let visibility: { showEvents: number; focusEvents: number; hidden: boolean } | null = null
      await attempt('window visibility', async () => {
        visibility = await windowGuard.evaluate((guard) => guard.finish())
      })
      await attempt('dispose window guard', () => windowGuard.dispose())
      await attempt('capture assertions', async () => {
        if (arm === 'mapped') {
          // Diagnostic mapped arm: presentation is explicit and focus stays untouched.
          expect(presentation.presented).toBe(true)
          expect(presentation.windows).toBeGreaterThan(0)
          expect(presentation.visible).toBe(presentation.windows)
          expect(visibility?.focusEvents).toBe(0)
          expect(visibility?.showEvents).toBeGreaterThanOrEqual(presentation.windows)
          expect(visibility?.hidden).toBe(false)
        } else {
          expect(presentation.presented).toBe(false)
          expect(visibility).toEqual({ showEvents: 0, focusEvents: 0, hidden: true })
        }
        expect(ackErrors).toEqual([])
        expect(frames, 'hidden compositor capture produced no frames').toBeGreaterThan(0)
        expect(acknowledged).toBe(frames)
      })
      const evidence = {
        platform: process.platform,
        case: caseId,
        arm,
        title: testInfo.title,
        presentation,
        clockCalibration,
        screencastFrames,
        referenceChannels,
        trace: traceEvidence,
        frames,
        acknowledged,
        ackErrors,
        frameSamples,
        visibility,
        errors: failures.map(({ stage, error }) => ({ stage, error: String(error) })),
        testErrors: testInfo.errors.map((error) => error.message)
      }
      console.log('[sidebar-hidden-capture]', JSON.stringify(evidence))
      await attempt('attach evidence', () =>
        testInfo.attach('sidebar-hidden-capture.json', {
          body: JSON.stringify(evidence, null, 2),
          contentType: 'application/json'
        })
      )
      if (failures.length === 1) {
        throw failures[0].error
      }
      if (failures.length > 1) {
        throw new AggregateError(
          failures.map(({ error }) => error),
          'Sidebar capture failed'
        )
      }
    },
    { auto: true }
  ]
})
