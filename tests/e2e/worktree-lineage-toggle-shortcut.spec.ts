import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { seedLineageScenario, seedWorkspaceLiveTerminal } from './worktree-lineage-state'
import { worktreeRow } from './worktree-row-locators'

const ACTION_ID = 'sidebar.childWorkspaces.toggle' as const
const CHORD = 'ControlOrMeta+Alt+KeyH'

async function setToggleBinding(page: Page, bindings: string[] | null): Promise<void> {
  await page.evaluate(
    async ({ actionId, bindings }) => {
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is not available')
      }
      const state = store.getState()
      await (bindings
        ? state.setKeybindingOverride(actionId, bindings)
        : state.resetKeybindingOverride(actionId))
    },
    { actionId: ACTION_ID, bindings }
  )
}

async function movePointerOffSidebar(page: Page): Promise<void> {
  const viewport =
    page.viewportSize() ??
    (await page.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight
    })))
  await page.mouse.move(viewport.width - 20, viewport.height / 2)
}

test.describe('Toggle Child Workspaces shortcut', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
  })

  test.afterEach(async ({ orcaPage }) => {
    await setToggleBinding(orcaPage, null)
  })

  test('hides and shows children of the active or hovered workspace', async ({ orcaPage }) => {
    const { parentId, childId } = await seedLineageScenario(orcaPage)
    await setToggleBinding(orcaPage, ['Mod+Alt+H'])
    const parentRow = worktreeRow(orcaPage, parentId)
    const childRow = worktreeRow(orcaPage, childId)

    await parentRow.click()
    await expect(parentRow).toHaveAttribute('aria-current', 'page')
    await expect(childRow).toBeVisible()

    // No hovered card: the active parent is the target.
    await movePointerOffSidebar(orcaPage)
    await orcaPage.keyboard.press(CHORD)
    await expect(childRow).toBeHidden()
    await expect(parentRow.getByRole('button', { name: 'Show 1 child workspace' })).toBeVisible()

    await orcaPage.keyboard.press(CHORD)
    await expect(childRow).toBeVisible()
    await expect(parentRow.getByRole('button', { name: 'Hide 1 child workspace' })).toBeVisible()

    // A hovered leaf child folds its parent.
    await childRow.hover()
    await orcaPage.keyboard.press(CHORD)
    await expect(childRow).toBeHidden()
    await expect(parentRow.getByRole('button', { name: 'Show 1 child workspace' })).toBeVisible()

    // A hovered parent unfolds its own children.
    await parentRow.hover()
    await orcaPage.keyboard.press(CHORD)
    await expect(childRow).toBeVisible()
  })

  test('does nothing while a sidebar filter hides every child', async ({ orcaPage }) => {
    const { parentId, childId } = await seedLineageScenario(orcaPage)
    await setToggleBinding(orcaPage, ['Mod+Alt+H'])
    await seedWorkspaceLiveTerminal(orcaPage, parentId)
    const parentRow = worktreeRow(orcaPage, parentId)
    const childRow = worktreeRow(orcaPage, childId)
    await parentRow.click()
    await expect(parentRow).toHaveAttribute('aria-current', 'page')

    const readCollapsedGroups = (): Promise<string[]> =>
      orcaPage.evaluate(() => [...(window.__store?.getState().collapsedGroups ?? [])].sort())
    const setShowSleeping = (show: boolean): Promise<void> =>
      orcaPage.evaluate((show) => window.__store?.getState().setShowSleepingWorkspaces(show), show)

    // The child has no live terminal, so hiding sleeping workspaces removes it and its chip.
    await setShowSleeping(false)
    try {
      await expect(childRow).toBeHidden()
      await expect(parentRow.getByRole('button', { name: /child workspace/ })).toHaveCount(0)
      const before = await readCollapsedGroups()

      // Checked after each press: two toggles of one key would cancel out.
      await movePointerOffSidebar(orcaPage)
      await orcaPage.keyboard.press(CHORD)
      expect(await readCollapsedGroups()).toEqual(before)
      await parentRow.hover()
      await orcaPage.keyboard.press(CHORD)
      expect(await readCollapsedGroups()).toEqual(before)
    } finally {
      await setShowSleeping(true)
    }
    await expect(childRow).toBeVisible()
  })
})
