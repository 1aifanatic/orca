import { test, expect } from './helpers/orca-app'
import { waitForSessionReady, waitForActiveWorktree } from './helpers/store'
import { seedLineageScenario } from './worktree-lineage-state'

import type { ConsoleMessage } from '@stablyai/playwright-test'

const backgroundLaunchBeforeControl = process.env.ORCA_BACKGROUND_LAUNCH
process.env.ORCA_BACKGROUND_LAUNCH = '1'

test.use({ launchEnv: { ORCA_BACKGROUND_LAUNCH: '1' } })

test.afterAll(() => {
  if (backgroundLaunchBeforeControl === undefined) {
    delete process.env.ORCA_BACKGROUND_LAUNCH
  } else {
    process.env.ORCA_BACKGROUND_LAUNCH = backgroundLaunchBeforeControl
  }
})

test('keyboard and chip preserve the scrolled parent, and unfolding opens the sidebar', async ({
  orcaPage,
  electronApp
}, testInfo) => {
  const forwardGeometry = (message: ConsoleMessage) => {
    const text = message.text()
    if (text.startsWith('LINEAGE_EXISTING_GEOMETRY ') || text.startsWith('LINEAGE_PRE_TOGGLE ')) {
      console.log(text)
    }
  }
  orcaPage.on('console', forwardGeometry)
  try {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    expect(
      await electronApp.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().every((window) => !window.isVisible())
      )
    ).toBe(true)
    await orcaPage.emulateMedia({ reducedMotion: 'reduce' })
    await orcaPage.setViewportSize({ width: 1200, height: 800 })
    const family = await seedLineageScenario(orcaPage)
    await orcaPage.evaluate(async ({ parentId, childId }) => {
      const store = window.__store
      if (!store) {
        throw new Error('Missing store')
      }
      const state = store.getState()
      const parent = Object.values(state.worktreesByRepo)
        .flat()
        .find((row) => row.id === parentId)
      if (!parent) {
        throw new Error('Missing parent')
      }
      const surrounding = Array.from({ length: 40 }, (_, index) => ({
        ...parent,
        id: `scroll-card-${index}`,
        instanceId: `scroll-instance-${index}`,
        displayName: `Surrounding workspace ${index}`,
        isMainWorktree: false,
        isPinned: false,
        parentWorktreeId: null,
        childWorktreeIds: [],
        lineage: null,
        sortOrder: 40 - index
      }))
      store.setState({
        sortBy: 'manual',
        worktreesByRepo: {
          ...state.worktreesByRepo,
          [parent.repoId]: [
            ...state.worktreesByRepo[parent.repoId].map((row) => ({
              ...row,
              sortOrder: row.id === parentId ? 16.5 : row.id === childId ? 16.4 : row.sortOrder
            })),
            ...surrounding
          ]
        }
      })
      await store.getState().setKeybindingOverride('sidebar.childWorkspaces.toggle', ['Mod+Alt+H'])
    }, family)

    const sidebar = orcaPage.locator('[data-worktree-sidebar]')
    const parentRow = sidebar
      .locator(`[role="option"][data-worktree-id=${JSON.stringify(family.parentId)}]`)
      .first()
    const childRow = sidebar
      .locator(`[role="option"][data-worktree-id=${JSON.stringify(family.childId)}]`)
      .first()
    await orcaPage.getByRole('button', { name: 'Reveal active workspace' }).click()
    await expect(parentRow).toBeVisible()
    await parentRow.evaluate((row) => row.scrollIntoView({ block: 'center' }))
    await expect.poll(() => sidebar.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
    const geometry = (arm = false) =>
      parentRow.evaluate((row, arm) => {
        const sidebar = row.closest('[data-worktree-sidebar]')
        const parentRect = row.getBoundingClientRect()
        const measurement = {
          top: parentRect.top,
          scrollTop: sidebar?.scrollTop ?? 0
        }
        console.log(
          'LINEAGE_EXISTING_GEOMETRY',
          JSON.stringify({
            ...measurement,
            documentTop: measurement.top + measurement.scrollTop,
            time: performance.now(),
            fonts: document.fonts.status,
            sidebarHeight: sidebar?.clientHeight ?? null,
            scrollHeight: sidebar?.scrollHeight ?? null
          })
        )
        if (arm && sidebar instanceof HTMLElement) {
          const controller = new AbortController()
          let samples = 0
          const rowIdentity = (element: Element | null) => ({
            key: element?.getAttribute('data-worktree-virtual-row-key') ?? null,
            index: element?.getAttribute('data-index') ?? null,
            start: element?.getAttribute('data-worktree-virtual-row-start') ?? null,
            transform: element instanceof HTMLElement ? element.style.transform : null
          })
          const capture = (phase: string, event?: KeyboardEvent, initialRect?: DOMRect) => {
            if (samples >= 8) {
              controller.abort()
              return
            }
            try {
              const rect = row.isConnected ? (initialRect ?? row.getBoundingClientRect()) : null
              const virtualRow = row.closest('[data-worktree-virtual-row]')
              const canvas = virtualRow?.parentElement
              console.log(
                'LINEAGE_PRE_TOGGLE',
                JSON.stringify({
                  phase,
                  sequence: ++samples,
                  time: performance.now(),
                  parentId: row.getAttribute('data-worktree-id'),
                  connected: row.isConnected,
                  top: rect?.top ?? null,
                  parentHeight: rect?.height ?? null,
                  scrollTop: sidebar.scrollTop,
                  sidebarTop: sidebar.getBoundingClientRect().top,
                  sidebarHeight: sidebar.clientHeight,
                  scrollHeight: sidebar.scrollHeight,
                  fonts: document.fonts.status,
                  virtualRow: rowIdentity(virtualRow),
                  virtualHeight: virtualRow instanceof HTMLElement ? virtualRow.offsetHeight : null,
                  canvasHeight: canvas instanceof HTMLElement ? canvas.style.height : null,
                  previous: rowIdentity(virtualRow?.previousElementSibling ?? null),
                  next: rowIdentity(virtualRow?.nextElementSibling ?? null),
                  key: event
                    ? {
                        code: event.code,
                        key: event.key,
                        ctrl: event.ctrlKey,
                        meta: event.metaKey,
                        alt: event.altKey,
                        shift: event.shiftKey,
                        repeat: event.repeat,
                        defaultPrevented: event.defaultPrevented
                      }
                    : null
                })
              )
            } catch (error) {
              controller.abort()
              console.log(
                'LINEAGE_PRE_TOGGLE',
                JSON.stringify({ phase, captureError: String(error) })
              )
            }
          }
          sidebar.addEventListener(
            'orca-record-virtualized-scroll-anchor',
            () => {
              capture('anchor-request-before-record-and-group-toggle')
            },
            { capture: true, passive: true, signal: controller.signal }
          )
          window.addEventListener(
            'keydown',
            (event) => {
              if (/^(Control|Meta|Alt|Shift)(Left|Right)$/.test(event.code)) {
                capture('modifier-keydown-after-earlier-window-handlers', event)
              } else if (event.code === 'KeyH') {
                capture('H-keydown-after-earlier-window-handlers', event)
                controller.abort()
              }
            },
            { capture: true, passive: true, signal: controller.signal }
          )
          window.addEventListener('pagehide', () => controller.abort(), {
            once: true,
            passive: true,
            signal: controller.signal
          })
          capture('baseline', undefined, parentRect)
        }
        return measurement
      }, arm)
    const before = await geometry(true)
    console.log('LINEAGE_EXISTING_BASELINE', JSON.stringify(before))
    await orcaPage.mouse.move(1150, 400)
    await orcaPage.keyboard.press('ControlOrMeta+Alt+KeyH')
    await expect(childRow).toBeHidden()
    await expect.poll(async () => Math.abs((await geometry()).top - before.top)).toBeLessThan(2)
    expect((await geometry()).scrollTop).toBeGreaterThan(0)
    const collapsedProof = testInfo.outputPath('keyboard-collapsed-parent-anchor.png')
    await sidebar.screenshot({ path: collapsedProof })
    await testInfo.attach('keyboard-collapsed-parent-anchor', {
      path: collapsedProof,
      contentType: 'image/png'
    })

    await parentRow.getByRole('button', { name: 'Show 1 child workspace' }).click()
    await expect(childRow).toBeVisible()
    await expect.poll(async () => Math.abs((await geometry()).top - before.top)).toBeLessThan(2)
    await orcaPage.mouse.move(1150, 400)
    await orcaPage.keyboard.press('ControlOrMeta+Alt+KeyH')
    await expect(childRow).toBeHidden()
    await orcaPage.evaluate(() => window.__store?.getState().setSidebarOpen(false))
    await expect(sidebar).toBeHidden()
    await orcaPage.keyboard.press('ControlOrMeta+Alt+KeyH')
    await expect(sidebar).toBeVisible()
    await expect(childRow).toBeVisible()
  } finally {
    orcaPage.off('console', forwardGeometry)
  }
})
