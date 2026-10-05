import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from './helpers/orca-app'

test('CSV links navigate from small and paged previews without replacing the renderer', async ({
  orcaPage,
  seededRepoPath,
  electronApp
}, testInfo) => {
  test.setTimeout(90_000)
  const url = 'https://example.com/?from=csv#demo'
  const smallName = 'csv-links.csv'
  const largeName = 'csv-links-large.csv'
  const content = `name,url,notes\nExample,${url},javascript:alert(1)\n`
  writeFileSync(path.join(seededRepoPath, smallName), content)
  writeFileSync(
    path.join(seededRepoPath, largeName),
    content + `Record,${url},${'x'.repeat(200)}\n`.repeat(6000)
  )
  await orcaPage.evaluate(async () => {
    await window.__store?.getState().updateSettings({ openLinksInApp: true })
  })
  for (const name of [smallName, largeName]) {
    await orcaPage.evaluate(
      ({ name, filePath }) => {
        const state = window.__store?.getState()
        if (!state?.activeWorktreeId) {
          throw new Error('Missing CSV test workspace')
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
      { name, filePath: path.join(seededRepoPath, name) }
    )
    const link = orcaPage.getByRole('table').getByRole('link', { name: url }).first()
    await expect(link).toBeVisible({ timeout: 30_000 })
    await expect(link).toHaveAttribute('href', url)
    await expect(
      orcaPage.getByRole('cell', { name: 'javascript:alert(1)', exact: true })
    ).toBeVisible()
    await orcaPage.screenshot({ path: testInfo.outputPath(`${name}.png`) })
    const rendererUrl = orcaPage.url()
    const tabsBefore = await orcaPage.evaluate(
      () => Object.values(window.__store?.getState().browserTabsByWorktree ?? {}).flat().length
    )
    if (name === largeName) {
      await link.focus()
      await orcaPage.keyboard.press('Enter')
    } else {
      await link.click()
    }
    await expect
      .poll(() =>
        orcaPage.evaluate(
          () => Object.values(window.__store?.getState().browserTabsByWorktree ?? {}).flat().length
        )
      )
      .toBe(tabsBefore + 1)
    expect(
      await orcaPage.evaluate(
        () =>
          Object.values(window.__store?.getState().browserTabsByWorktree ?? {})
            .flat()
            .at(-1)?.url
      )
    ).toBe(url)
    expect(orcaPage.url()).toBe(rendererUrl)
  }
  expect(
    await electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().some((window) => window.isVisible())
    )
  ).toBe(false)
})
