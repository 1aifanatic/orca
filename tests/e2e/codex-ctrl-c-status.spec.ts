import { test, expect } from './helpers/orca-app'
import { emitCodexHookStatus, readHookEndpoint } from './helpers/agent-hook-endpoint'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  focusActiveTerminalInput,
  waitForActivePaneHookDescriptor,
  waitForActiveTerminalManager
} from './helpers/terminal'

test('Codex Ctrl+C preserves the rendered working status', async ({
  orcaPage,
  electronApp
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage, 30_000)
  const endpoint = await readHookEndpoint(electronApp)
  const descriptor = await waitForActivePaneHookDescriptor(orcaPage)
  await orcaPage.evaluate(() => {
    const state = window.__store?.getState()
    state?.setAgentActivityDisplayMode('full')
    if (state && !state.worktreeCardProperties.includes('inline-agents')) {
      state.setWorktreeCardProperties([...state.worktreeCardProperties, 'inline-agents'])
    }
  })
  await emitCodexHookStatus(endpoint, {
    ...descriptor,
    state: 'working',
    prompt: 'Main task continues'
  })
  const working = orcaPage.locator('[aria-label="Working"]')
  const interrupted = orcaPage.locator('[aria-label="Interrupted"]')
  await expect(working.first()).toBeVisible()
  await focusActiveTerminalInput(orcaPage)
  await orcaPage.keyboard.press('Control+c')
  // Allow the old 500 ms inference timer to fire before recording the rendered result.
  await orcaPage.waitForTimeout(1_000)
  await orcaPage.screenshot({
    path: testInfo.outputPath('status-after-ctrl-c.png'),
    clip: { x: 0, y: 180, width: 280, height: 240 }
  })
  await expect(interrupted).toHaveCount(0)
  await expect(working.first()).toBeVisible()

  await emitCodexHookStatus(endpoint, { ...descriptor, state: 'done' })
  await expect(working).toHaveCount(0)
  await expect(interrupted).toHaveCount(0)
})
