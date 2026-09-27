import { test as base, expect } from './helpers/orca-app'

export { expect }

export const test = base.extend<{ sidebarAnimationFrames: void }>({
  orcaAppExtraEnv: { ORCA_BACKGROUND_LAUNCH: '1' },
  orcaAppExtraArgs: [
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding'
  ],
  sidebarAnimationFrames: [
    async ({ electronApp, orcaPage }, use) => {
      // Hidden Linux windows otherwise deliver roughly one animation frame per second.
      await electronApp.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(false)
      })
      await orcaPage.setViewportSize({ width: 1280, height: 1024 })
      await use()
      expect(
        await electronApp.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().every(
            (window) => !window.isVisible() && !window.isFocused()
          )
        )
      ).toBe(true)
    },
    { auto: true }
  ]
})
