import { expect, test } from './helpers/orca-app'

test.use({ seedTestRepo: false })

test('shows one delayed-save notice, restores it after reload, and clears on recovery', async ({
  electronApp,
  orcaPage
}, testInfo) => {
  expect(await orcaPage.evaluate(() => window.api.app.isProfileStateSaveDelayed())).toBe(false)

  const setSaveDelayed = async (delayed: boolean): Promise<void> => {
    // Simulate the writer's status without stalling the app or touching real profile data.
    await electronApp.evaluate(({ ipcMain }, value) => {
      ipcMain.removeHandler('app:isProfileStateSaveDelayed')
      ipcMain.handle('app:isProfileStateSaveDelayed', () => value)
    }, delayed)
    const window = await electronApp.browserWindow(orcaPage)
    await window.evaluate((browserWindow, value) => {
      browserWindow.webContents.send('app:profileStateSaveDelayChanged', value)
    }, delayed)
    await window.dispose()
  }

  const notice = orcaPage.locator('[data-sonner-toast]').filter({
    hasText: 'Saving is taking longer than usual'
  })
  await setSaveDelayed(true)
  await expect(notice).toHaveCount(1)
  await expect(notice).toBeVisible()
  await expect(notice).toContainText(
    'Recent changes haven’t been confirmed saved yet. Orca is still trying.'
  )
  await expect(notice.getByRole('button')).toHaveCount(0)
  await expect(notice).toHaveCSS('opacity', '1')
  const screenshot = testInfo.outputPath('delayed-save-notice.png')
  await orcaPage.screenshot({ path: screenshot })
  await testInfo.attach('delayed-save-notice', { path: screenshot, contentType: 'image/png' })

  await setSaveDelayed(true)
  await expect(notice).toHaveCount(1)
  await orcaPage.reload()
  await expect(notice).toBeVisible()
  expect(await orcaPage.evaluate(() => window.api.app.isProfileStateSaveDelayed())).toBe(true)

  await setSaveDelayed(false)
  await expect(notice).toHaveCount(0)
})
