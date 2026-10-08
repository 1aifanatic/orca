/**
 * Main writes the terminal layout and windows mirror it, so a tab main creates or edits must
 * reach the window with the title and place the user would see on the old window-written path:
 * a CLI `--title`, and a split pane closed on the desktop while a web client is paired.
 */
import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { runCompiledOrcaCli } from './helpers/compiled-orca-cli'
import { waitForPairedClientWorktree } from './helpers/paired-client-host-session'
import {
  createRuntimeDesktopPairingOffer,
  launchPairedWebClient
} from './helpers/paired-electron-client'
import { ensureTerminalVisible, waitForSessionReady } from './helpers/store'
import {
  focusActiveTerminalInput,
  splitActiveTerminalPane,
  waitForActiveTerminalManager,
  waitForPaneCount
} from './helpers/terminal'
import { createTerminalTabFromMenu, SORTABLE_TAB } from './helpers/terminal-tab-menu'

type TabRow = { id: string; title: string }

async function activeWorktreeId(page: Page): Promise<string> {
  await waitForSessionReady(page)
  await ensureTerminalVisible(page)
  await waitForActiveTerminalManager(page, 30_000)
  const worktreeId = await page.evaluate(() => window.__store?.getState().activeWorktreeId)
  if (!worktreeId) {
    throw new Error('No active worktree')
  }
  return worktreeId
}

/** The tab bar as the user reads it: order and shown title. */
function readTabs(page: Page, worktreeId: string): Promise<TabRow[]> {
  return page.evaluate((wt) => {
    const state = window.__store!.getState()
    const key =
      Object.keys(state.tabsByWorktree).find(
        (candidate) => candidate === wt || candidate.includes(wt)
      ) ?? wt
    return (state.tabsByWorktree[key] ?? []).map((tab) => ({
      id: tab.id,
      title: tab.customTitle ?? tab.title
    }))
  }, worktreeId)
}

test('a CLI-created terminal shows the title it was created with', async ({
  electronApp,
  orcaPage
}) => {
  const worktreeId = await activeWorktreeId(orcaPage)
  const userDataDir = await electronApp.evaluate(({ app }) => app.getPath('userData'))

  const created = await runCompiledOrcaCli(userDataDir, [
    'terminal',
    'create',
    '--worktree',
    `id:${worktreeId}`,
    '--title',
    'cli-made',
    '--json'
  ])
  expect(created.code).toBe(0)

  await expect
    .poll(async () => (await readTabs(orcaPage, worktreeId)).map((tab) => tab.title), {
      timeout: 15_000
    })
    .toContain('cli-made')
  const listed = await runCompiledOrcaCli(userDataDir, [
    'terminal',
    'list',
    '--worktree',
    `id:${worktreeId}`,
    '--json'
  ])
  expect(listed.stdout).toContain('"cli-made"')
})

test('closing a split pane on the desktop keeps its tab in place while a web client is paired', async ({
  electronApp,
  orcaPage
}) => {
  test.skip(process.env.ORCA_E2E_WEB_CLIENT !== '1', 'Needs the paired web client build')
  const worktreeId = await activeWorktreeId(orcaPage)
  const client = await launchPairedWebClient(
    electronApp,
    await createRuntimeDesktopPairingOffer(orcaPage)
  )
  try {
    await waitForPairedClientWorktree(client.page, worktreeId)
    await client.page.evaluate((wt) => {
      const state = window.__store!.getState()
      state.setActiveView?.('terminal')
      state.setActiveWorktree(wt)
    }, worktreeId)

    await splitActiveTerminalPane(orcaPage, 'vertical')
    await waitForPaneCount(orcaPage, 2, 30_000)
    await createTerminalTabFromMenu(orcaPage)
    await waitForPaneCount(orcaPage, 1, 30_000)
    const before = await readTabs(orcaPage, worktreeId)
    expect(before).toHaveLength(2)
    await expect
      .poll(() => readTabs(client.page, worktreeId).then((tabs) => tabs.map((tab) => tab.title)), {
        timeout: 15_000
      })
      .toEqual(before.map((tab) => tab.title))

    await orcaPage.locator(SORTABLE_TAB).first().click()
    await waitForPaneCount(orcaPage, 2, 30_000)
    await focusActiveTerminalInput(orcaPage)
    await orcaPage.keyboard.press(process.platform === 'darwin' ? 'Meta+w' : 'Control+w')
    const confirm = orcaPage.getByRole('button', { name: 'Stop and Close' })
    if (await confirm.isVisible({ timeout: 1_000 }).catch(() => false)) {
      await confirm.click()
    }
    await waitForPaneCount(orcaPage, 1, 30_000)

    // Why a hold: the regression withdrew the tab when the closed pane's PTY exited, then
    // re-added it last and untitled, seconds after the close.
    await orcaPage.waitForTimeout(5_000)
    expect(await readTabs(orcaPage, worktreeId)).toEqual(before)
    await expect
      .poll(() => readTabs(client.page, worktreeId).then((tabs) => tabs.map((tab) => tab.title)), {
        timeout: 15_000
      })
      .toEqual(before.map((tab) => tab.title))
  } finally {
    await client.dispose()
  }
})
