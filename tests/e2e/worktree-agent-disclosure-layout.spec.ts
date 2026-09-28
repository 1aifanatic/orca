import type { Locator } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { seedLineageScenario } from './worktree-lineage-state'
import { worktreeRow } from './worktree-row-locators'

async function expectContainedAndAligned(row: Locator): Promise<void> {
  await expect
    .poll(async () =>
      row.evaluate((element) => {
        const surface = element.querySelector('[data-worktree-card-surface]')
        const parent = element.querySelector('.compact-agent-row.worktree-agent-lineage-parent-row')
        const independent = [...element.querySelectorAll('.compact-agent-row')].find((agent) =>
          agent.textContent?.includes('Independent agent')
        )
        const disclosure = parent?.querySelector('button')
        const parentDot = parent?.querySelector('span[aria-label]')
        const siblingDot = independent?.querySelector('span[aria-label]')
        const childDot = element.querySelector('.worktree-agent-lineage-children span[aria-label]')
        if (!surface || !parent || !disclosure || !parentDot || !siblingDot || !childDot) {
          return false
        }
        const card = surface.getBoundingClientRect()
        const button = disclosure.getBoundingClientRect()
        return (
          parent.getBoundingClientRect().left >= card.left &&
          button.left >= card.left &&
          button.right <= card.right &&
          Math.abs(
            parentDot.getBoundingClientRect().left - siblingDot.getBoundingClientRect().left
          ) < 1 &&
          childDot.getBoundingClientRect().left > parentDot.getBoundingClientRect().left
        )
      })
    )
    .toBe(true)
}

test('compact agent disclosures stay inside nested cards and preserve sibling columns', async ({
  orcaPage
}) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  const { childId } = await seedLineageScenario(orcaPage)
  const row = worktreeRow(orcaPage, childId)
  await row.click()
  await orcaPage.evaluate((worktreeId) => {
    const store = window.__store
    if (!store) {
      throw new Error('Store unavailable')
    }
    const state = store.getState()
    state.setAgentActivityDisplayMode('compact')
    store.setState({
      worktreeCardProperties: [
        ...new Set([...state.worktreeCardProperties, 'inline-agents', 'status'])
      ]
    })
    for (const [index, prompt] of ['Parent agent', 'Independent agent'].entries()) {
      const tab = state.createTab(worktreeId)
      const now = Date.now()
      state.setAgentStatus(
        `${tab.id}:${crypto.randomUUID()}`,
        {
          state: 'working',
          prompt,
          agentType: 'claude',
          subagents:
            index === 0
              ? [
                  {
                    id: 'layout-child',
                    state: 'working',
                    startedAt: now,
                    description: 'Nested agent'
                  }
                ]
              : undefined
        },
        'claude',
        { updatedAt: now, stateStartedAt: now }
      )
    }
  }, childId)
  const summary = row.locator('button.compact-agent-summary-button')
  await summary.click()
  await expect(summary).toHaveAttribute('aria-expanded', 'true')

  for (const width of [410, 280]) {
    for (const showStatus of [true, false]) {
      await orcaPage.evaluate(
        ({ width, showStatus }) => {
          const store = window.__store
          if (!store) {
            throw new Error('Store unavailable')
          }
          store.getState().setSidebarWidth(width)
          store.setState((state) => ({
            worktreeCardProperties: showStatus
              ? [...new Set([...state.worktreeCardProperties, 'status'])]
              : state.worktreeCardProperties.filter((property) => property !== 'status')
          }))
        },
        { width, showStatus }
      )
      await expectContainedAndAligned(row)
      const disclosure = row.locator('.compact-agent-child-disclosure-button')
      await disclosure.click()
      await expect(disclosure).toHaveAttribute('aria-expanded', 'false')
      await disclosure.press('Enter')
      await expect(disclosure).toHaveAttribute('aria-expanded', 'true')
      await expect(row).toHaveAttribute('aria-current', 'page')
    }
  }
})
