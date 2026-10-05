import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from './helpers/orca-app'

test('CSV delimiter control and menu stay anchored across separator choices', async ({
  orcaPage,
  seededRepoPath,
  electronApp
}, testInfo) => {
  const content = `Name;Description\nExample;${'x'.repeat(200)}\n`
  const files = [
    { name: 'delimiter-layout.csv', content },
    { name: 'delimiter-layout-large.csv', content: content.repeat(6000) }
  ]
  for (const file of files) {
    const large = file.name.endsWith('large.csv')
    if (large) {
      await orcaPage.setViewportSize({ width: 1000, height: 900 })
    }
    await orcaPage.evaluate(async (dark) => {
      await window.__store?.getState().updateSettings({ theme: dark ? 'dark' : 'light' })
    }, large)
    writeFileSync(path.join(seededRepoPath, file.name), file.content)
    await orcaPage.evaluate(
      ({ name, filePath }) => {
        const state = window.__store?.getState()
        if (!state?.activeWorktreeId) {
          throw new Error('Missing CSV workspace')
        }
        state.openFile(
          {
            filePath,
            relativePath: name,
            worktreeId: state.activeWorktreeId,
            language: 'plaintext',
            mode: 'edit'
          },
          { preview: false }
        )
      },
      { name: file.name, filePath: path.join(seededRepoPath, file.name) }
    )
    const label = orcaPage.getByText('Delimiter', { exact: true })
    const trigger = label.locator('..').locator('[data-slot="select-trigger"]')
    await expect(trigger).toHaveText('Auto (Semicolon)')
    if (large) {
      await expect(orcaPage.getByText('Large file preview · Read-only')).toBeVisible()
    }
    await orcaPage.evaluate(() => document.fonts.ready)
    const positions = []
    const frames = []
    for (const next of ['Tab', 'Comma (,)', 'Semicolon (;)', 'Auto (Semicolon)']) {
      await trigger.click()
      const menu = orcaPage.getByRole('listbox')
      await expect(menu).toBeVisible()
      await menu.evaluate(async (element) => {
        await Promise.all(element.getAnimations().map((animation) => animation.finished))
      })
      const triggerBox = await trigger.boundingBox()
      const menuBox = await menu.boundingBox()
      const labelBox = await label.boundingBox()
      if (!triggerBox || !menuBox || !labelBox) {
        throw new Error('Missing delimiter control geometry')
      }
      positions.push({ trigger: triggerBox, menu: menuBox, label: labelBox })
      if (next === 'Tab' || next === 'Comma (,)') {
        await orcaPage.screenshot({
          path: testInfo.outputPath(`${file.name}-${next === 'Tab' ? 'auto' : 'tab'}.png`)
        })
      }
      const sampledFrames = orcaPage.evaluate(async () => {
        const samples = []
        for (let frame = 0; frame < 20; frame++) {
          await new Promise(requestAnimationFrame)
          const element = document.querySelector('[data-slot="select-trigger"]')
          if (!element) {
            throw new Error('Delimiter control disappeared')
          }
          const { x, y, width, height } = element.getBoundingClientRect()
          samples.push({ x, y, width, height })
        }
        return samples
      })
      await orcaPage.getByRole('option', { name: next, exact: true }).click()
      frames.push(...(await sampledFrames))
      await expect(trigger).toHaveText(next)
      if (!large) {
        await expect(trigger).toBeFocused()
      }
    }
    const initial = positions[0]!
    for (const frame of frames) {
      for (const key of ['x', 'y', 'width', 'height'] as const) {
        expect(frame[key]).toBeCloseTo(initial.trigger[key], 0)
      }
    }
    for (const position of positions) {
      for (const key of ['x', 'y', 'width', 'height'] as const) {
        expect(position.trigger[key]).toBeCloseTo(initial.trigger[key], 0)
        expect(position.menu[key]).toBeCloseTo(initial.menu[key], 0)
        expect(position.label[key]).toBeCloseTo(initial.label[key], 0)
      }
      expect(position.menu.y + position.menu.height).toBeLessThanOrEqual(position.trigger.y)
      expect(position.menu.x + position.menu.width).toBeCloseTo(
        position.trigger.x + position.trigger.width,
        0
      )
    }
  }
  expect(
    await electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().some((window) => window.isVisible())
    )
  ).toBe(false)
})
