import { test as base, expect } from './helpers/orca-app'

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
        BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(false)
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
      const frameSamples: { phase: string; elapsedMs: number[]; timedOut: boolean }[] = []
      const sampleFrames = async (phase: string) => {
        const sample = await orcaPage.evaluate(
          () =>
            new Promise<{
              elapsedMs: number[]
              timedOut: boolean
            }>((resolve) => {
              const elapsedMs: number[] = []
              const started = performance.now()
              let frame = 0
              const timeout = setTimeout(() => {
                cancelAnimationFrame(frame)
                resolve({ elapsedMs, timedOut: true })
              }, 5000)
              const tick = () => {
                elapsedMs.push(performance.now() - started)
                if (elapsedMs.length === 3) {
                  clearTimeout(timeout)
                  resolve({ elapsedMs, timedOut: false })
                } else {
                  frame = requestAnimationFrame(tick)
                }
              }
              frame = requestAnimationFrame(tick)
            })
        )
        frameSamples.push({ phase, ...sample })
        expect(sample.timedOut, 'native animation frame sampling timed out').toBe(false)
      }
      try {
        const cdp = await orcaPage.context().newCDPSession(orcaPage)
        const pending = new Set<Promise<void>>()
        const onFrame = ({ sessionId }: { sessionId: number }) => {
          frames++
          const ack = cdp.send('Page.screencastFrameAck', { sessionId }).then(
            () => {
              acknowledged++
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
          await provideFixture()
          await sampleFrames('after')
        } finally {
          try {
            await cdp.send('Page.stopScreencast')
          } finally {
            cdp.off('Page.screencastFrame', onFrame)
            await Promise.all(pending)
            await cdp.detach()
          }
        }
      } finally {
        const visibility = await windowGuard
          .evaluate((guard) => guard.finish())
          .finally(() => windowGuard.dispose())
        const evidence = {
          platform: process.platform,
          frames,
          acknowledged,
          ackErrors,
          frameSamples,
          visibility
        }
        await testInfo.attach('sidebar-hidden-capture.json', {
          body: JSON.stringify(evidence, null, 2),
          contentType: 'application/json'
        })
        console.log('[sidebar-hidden-capture]', JSON.stringify(evidence))
        expect(visibility).toEqual({ showEvents: 0, focusEvents: 0, hidden: true })
        expect(ackErrors).toEqual([])
        expect(frames, 'hidden compositor capture produced no frames').toBeGreaterThan(0)
        expect(acknowledged).toBe(frames)
      }
    },
    { auto: true }
  ]
})
