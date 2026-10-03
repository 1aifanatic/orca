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
  let disposeReadiness: (() => Promise<void>) | undefined
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
    const readiness = await parentRow.evaluateHandle((row, parentId) => {
      const sidebar = row.closest('[data-worktree-sidebar]')
      if (!(sidebar instanceof HTMLElement)) {
        throw new Error('Missing sidebar for scroll readiness')
      }
      const controller = new AbortController()
      let lastScrollAt = performance.now()
      let generation = 0
      let candidateGeneration = -1
      let candidateSignature: string | null = null
      let stableSince = lastScrollAt
      let frame: number | null = null
      let completedFrames = 0
      let stopped = false
      const rowIdentity = (element: Element | null) => ({
        key: element?.getAttribute('data-worktree-virtual-row-key') ?? null,
        index: element?.getAttribute('data-index') ?? null,
        start: element?.getAttribute('data-worktree-virtual-row-start') ?? null,
        transform: element instanceof HTMLElement ? element.style.transform : null
      })
      const snapshot = () => {
        const virtualRow = row.closest('[data-worktree-virtual-row]')
        const canvas = virtualRow?.parentElement
        const parentRect = row.getBoundingClientRect()
        const sidebarRect = sidebar.getBoundingClientRect()
        return {
          connected:
            row.isConnected &&
            sidebar.isConnected &&
            !!virtualRow?.isConnected &&
            !!canvas?.isConnected &&
            row.closest('[data-worktree-sidebar]') === sidebar,
          parentId: row.getAttribute('data-worktree-id'),
          top: parentRect.top,
          parentHeight: parentRect.height,
          virtualRow: rowIdentity(virtualRow),
          virtualHeight: virtualRow?.getBoundingClientRect().height ?? null,
          sidebarTop: sidebarRect.top,
          sidebarHeight: sidebarRect.height,
          sidebarClientHeight: sidebar.clientHeight,
          scrollTop: sidebar.scrollTop,
          scrollHeight: sidebar.scrollHeight,
          canvasHeight: canvas?.getBoundingClientRect().height ?? null,
          canvasStyleHeight: canvas instanceof HTMLElement ? canvas.style.height : null,
          mountedRows: Array.from(
            canvas?.querySelectorAll('[data-worktree-virtual-row]') ?? []
          ).map((element) => ({
            ...rowIdentity(element),
            height: element.getBoundingClientRect().height
          })),
          fonts: document.fonts.status
        }
      }
      const invalidate = () => {
        if (frame !== null) {
          cancelAnimationFrame(frame)
        }
        frame = null
        completedFrames = 0
        candidateSignature = null
      }
      const dispose = () => {
        if (stopped) {
          return
        }
        stopped = true
        controller.abort()
        invalidate()
      }
      sidebar.addEventListener(
        'scroll',
        () => {
          lastScrollAt = performance.now()
          generation += 1
          invalidate()
        },
        { passive: true, signal: controller.signal }
      )
      window.addEventListener('pagehide', dispose, {
        once: true,
        passive: true,
        signal: controller.signal
      })
      const completeFrame = () => {
        frame = null
        if (stopped) {
          return
        }
        if (
          generation !== candidateGeneration ||
          JSON.stringify(snapshot()) !== candidateSignature
        ) {
          invalidate()
          return
        }
        completedFrames += 1
        if (completedFrames < 2) {
          frame = requestAnimationFrame(completeFrame)
        }
      }
      return {
        matches: (element: Element) => element === row,
        dispose,
        read: () => {
          const now = performance.now()
          const geometry = snapshot()
          const signature = JSON.stringify(geometry)
          const valid =
            !stopped &&
            geometry.connected &&
            geometry.parentId === parentId &&
            geometry.virtualRow.key !== null &&
            geometry.virtualRow.index !== null &&
            geometry.virtualRow.start !== null &&
            geometry.scrollTop > 0 &&
            geometry.fonts === 'loaded'
          if (!valid || signature !== candidateSignature || generation !== candidateGeneration) {
            invalidate()
            candidateSignature = valid ? signature : null
            candidateGeneration = generation
            stableSince = now
          }
          const quietAndStable = valid && now - lastScrollAt >= 500 && now - stableSince >= 500
          if (quietAndStable && frame === null && completedFrames === 0) {
            frame = requestAnimationFrame(completeFrame)
          }
          return {
            ready: quietAndStable && completedFrames === 2,
            signature,
            top: geometry.top,
            scrollTop: geometry.scrollTop
          }
        }
      }
    }, family.parentId)
    let disposed = false
    disposeReadiness = async () => {
      if (disposed) {
        return
      }
      disposed = true
      try {
        try {
          await readiness.evaluate((probe) => probe.dispose())
        } finally {
          await readiness.dispose()
        }
      } catch (error) {
        // Renderer teardown must not replace the original assertion.
        if (
          !orcaPage.isClosed() &&
          !/Execution context was destroyed|Cannot find context|Target.*closed/.test(String(error))
        ) {
          throw error
        }
      }
    }
    await parentRow.evaluate((row) => row.scrollIntoView({ block: 'center' }))
    await expect.poll(() => sidebar.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
    let settledSignature = ''
    await expect
      .poll(
        async () => {
          const sample = await readiness.evaluate((probe) => probe.read())
          if (sample.ready) {
            settledSignature = sample.signature
          }
          return sample.ready
        },
        { intervals: [50], timeout: 10_000 }
      )
      .toBe(true)
    const geometry = (arm = false) =>
      parentRow.evaluate(
        (row, { arm, probe, settledSignature }) => {
          const sidebar = row.closest('[data-worktree-sidebar]')
          const parentRect = row.getBoundingClientRect()
          const measurement = {
            top: parentRect.top,
            scrollTop: sidebar?.scrollTop ?? 0
          }
          if (arm) {
            const final = probe?.read()
            if (
              !probe?.matches(row) ||
              !final?.ready ||
              final.signature !== settledSignature ||
              final.top !== measurement.top ||
              final.scrollTop !== measurement.scrollTop
            ) {
              throw new Error('Scroll readiness changed before the original baseline')
            }
            probe.dispose()
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
                    virtualHeight:
                      virtualRow instanceof HTMLElement ? virtualRow.offsetHeight : null,
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
        },
        { arm, probe: arm ? readiness : null, settledSignature }
      )
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
    await disposeReadiness?.()
  }
})
