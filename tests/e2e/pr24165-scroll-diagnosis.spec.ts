import { test, expect } from './helpers/orca-app'
import { waitForSessionReady, waitForActiveWorktree } from './helpers/store'
import { seedLineageScenario } from './worktree-lineage-state'

import type { Page, ElectronApplication, TestInfo } from '@stablyai/playwright-test'

const backgroundLaunchBeforeDiagnostic = process.env.ORCA_BACKGROUND_LAUNCH
process.env.ORCA_BACKGROUND_LAUNCH = '1'

test.use({ launchEnv: { ORCA_BACKGROUND_LAUNCH: '1' } })

test.afterAll(() => {
  if (backgroundLaunchBeforeDiagnostic === undefined) {
    delete process.env.ORCA_BACKGROUND_LAUNCH
  } else {
    process.env.ORCA_BACKGROUND_LAUNCH = backgroundLaunchBeforeDiagnostic
  }
})

async function observeScrollLayout(
  orcaPage: Page,
  family: Awaited<ReturnType<typeof seedLineageScenario>>
): Promise<void> {
  await orcaPage.evaluate(({ parentId, childId }) => {
    const sidebar = document.querySelector('[data-worktree-sidebar]')
    if (!(sidebar instanceof HTMLElement)) {
      throw new Error('Missing diagnostic sidebar')
    }
    const renderedSidebar = () => {
      const current = document.querySelector('[data-worktree-sidebar]')
      return current instanceof HTMLElement ? current : sidebar
    }
    const findRow = (id: string) =>
      Array.from(renderedSidebar().querySelectorAll('[role="option"][data-worktree-id]')).find(
        (row) => row.getAttribute('data-worktree-id') === id
      )
    const entries: unknown[] = []
    const bounds = {
      maxEntries: 2048,
      maxFrames: 1200,
      maxObservedRows: 256,
      frames: 0,
      dropped: 0
    }
    const environment = {
      userAgent: navigator.userAgent,
      visibilityState: document.visibilityState,
      width: innerWidth,
      height: innerHeight,
      pixelRatio: devicePixelRatio,
      fonts: document.fonts.status,
      fontFamily: getComputedStyle(document.body).fontFamily,
      frameMeaning:
        'JavaScript requestAnimationFrame callback; hidden compositor paint is not asserted',
      keydownMeaning: 'Document capture executes after the existing window capture handler'
    }
    const capture = (phase: string, detailed = false) => {
      observeMountedRows()
      const currentSidebar = renderedSidebar()
      const rect = findRow(parentId)?.getBoundingClientRect()
      const childRect = findRow(childId)?.getBoundingClientRect()
      const sidebarRect = currentSidebar.getBoundingClientRect()
      const state = {
        phase,
        time: performance.now(),
        top: rect?.top ?? null,
        height: rect?.height ?? null,
        childTop: childRect?.top ?? null,
        childHeight: childRect?.height ?? null,
        childBottom: childRect?.bottom ?? null,
        sidebarTop: sidebarRect.top,
        sidebarHeight: sidebarRect.height,
        scrollTop: currentSidebar.scrollTop,
        scrollHeight: currentSidebar.scrollHeight,
        clientHeight: currentSidebar.clientHeight,
        sidebarConnected: currentSidebar.isConnected,
        fontStatus: document.fonts.status,
        rows: detailed
          ? Array.from(currentSidebar.querySelectorAll('[data-worktree-virtual-row]')).map(
              (row) => ({
                key: row.getAttribute('data-worktree-virtual-row-key'),
                top: row.getBoundingClientRect().top,
                height: row.getBoundingClientRect().height
              })
            )
          : undefined
      }
      if (entries.length < bounds.maxEntries) {
        entries.push(state)
      } else {
        bounds.dropped += 1
      }
      return [state.top, state.height, state.childTop, state.scrollTop, state.scrollHeight].join(
        '|'
      )
    }
    let stopped = false
    let animationFrame = 0
    const listenerController = new AbortController()
    const observedRows = new Set<Element>()
    const resizeObserver = new ResizeObserver(() => {
      if (!stopped) {
        capture('resize-observer', true)
      }
    })
    const observeMountedRows = () => {
      if (stopped) {
        return
      }
      for (const row of [
        document.documentElement,
        renderedSidebar(),
        ...renderedSidebar().querySelectorAll('[data-worktree-virtual-row]'),
        findRow(parentId),
        findRow(childId)
      ]) {
        if (row && !observedRows.has(row) && observedRows.size < bounds.maxObservedRows) {
          observedRows.add(row)
          resizeObserver.observe(row)
        }
      }
    }
    observeMountedRows()
    for (const phase of ['loading', 'loadingdone', 'loadingerror']) {
      document.fonts.addEventListener(phase, () => capture(`fonts-${phase}`, true), {
        signal: listenerController.signal
      })
    }
    let prior = capture('installed-before-reveal', true)
    const sample = () => {
      if (stopped || bounds.frames >= bounds.maxFrames) {
        return
      }
      bounds.frames += 1
      observeMountedRows()
      const currentSidebar = renderedSidebar()
      const row = findRow(parentId)?.getBoundingClientRect()
      const next = [
        row?.top ?? null,
        row?.height ?? null,
        findRow(childId)?.getBoundingClientRect().top ?? null,
        currentSidebar.scrollTop,
        currentSidebar.scrollHeight
      ].join('|')
      if (next !== prior) {
        prior = capture('request-animation-frame-sample', true)
      }
      animationFrame = requestAnimationFrame(sample)
    }
    animationFrame = requestAnimationFrame(sample)
    document.addEventListener(
      'orca-lineage-diagnostic-mark',
      (event) => {
        if (!(event instanceof CustomEvent) || typeof event.detail !== 'string') {
          return
        }
        if (event.detail === 'test-ended') {
          stopped = true
          cancelAnimationFrame(animationFrame)
          resizeObserver.disconnect()
          try {
            capture(event.detail, true)
          } finally {
            listenerController.abort()
          }
        } else {
          capture(event.detail, true)
        }
      },
      { signal: listenerController.signal }
    )
    document.addEventListener(
      'orca-record-virtualized-scroll-anchor',
      () => capture('anchor-request', true),
      {
        capture: true,
        signal: listenerController.signal
      }
    )
    document.addEventListener(
      'scroll',
      (event) => {
        if (event.target === renderedSidebar()) {
          capture('sidebar-scroll', true)
        }
      },
      { capture: true, passive: true, signal: listenerController.signal }
    )
    document.addEventListener(
      'wheel',
      (event) => {
        if (event.target instanceof Node && renderedSidebar().contains(event.target)) {
          capture('wheel', true)
        }
      },
      { capture: true, passive: true, signal: listenerController.signal }
    )
    document.addEventListener(
      'keydown',
      (event) => {
        if (event.code === 'KeyH') {
          capture('document-keydown-after-window-handler', true)
        }
      },
      { capture: true, signal: listenerController.signal }
    )
    Reflect.set(window, '__lineageScrollDiagnostic', { environment, bounds, entries })
  }, family)
}

async function markScrollPhase(orcaPage: Page, phase: string): Promise<void> {
  await orcaPage.evaluate(
    (phase) =>
      document.dispatchEvent(new CustomEvent('orca-lineage-diagnostic-mark', { detail: phase })),
    phase
  )
}

async function seedScrolledFamily(orcaPage: Page) {
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

  return family
}

type ScrollDiagnosticCase = {
  name: string
  baseline?: { top: number; scrollTop: number }
}

async function runScrollDiagnostic(
  orcaPage: Page,
  electronApp: ElectronApplication,
  testInfo: TestInfo,
  scenario: ScrollDiagnosticCase,
  flow: () => Promise<void>
): Promise<void> {
  const launchAtStart = await electronApp.evaluate(({ BrowserWindow }) => ({
    backgroundLaunch: process.env.ORCA_BACKGROUND_LAUNCH,
    headless: process.env.ORCA_E2E_HEADLESS,
    windows: BrowserWindow.getAllWindows().map((window) => ({
      visible: window.isVisible(),
      focused: window.isFocused()
    }))
  }))
  if (
    launchAtStart.backgroundLaunch !== '1' ||
    launchAtStart.headless !== '1' ||
    launchAtStart.windows.length === 0 ||
    launchAtStart.windows.some((window) => window.visible || window.focused)
  ) {
    throw new Error(
      'Diagnostic requires actual background/headless launch and hidden/unfocused windows'
    )
  }
  const captureFailures: { phase: string; message: string }[] = []
  let primaryFailure: unknown
  let rendererGeometry: unknown = { missing: true }
  let launchAtEnd: unknown = { missing: true }
  const captureDiagnosticEvidence = async (phase: string, capture: () => Promise<void>) => {
    try {
      await capture()
    } catch (error) {
      captureFailures.push({
        phase,
        message: error instanceof Error ? error.message : String(error)
      })
    }
  }
  await orcaPage.context().tracing.start({ screenshots: true, snapshots: true, sources: true })
  try {
    await flow()
  } catch (error) {
    primaryFailure = error
  } finally {
    await captureDiagnosticEvidence('geometry-and-listener-cleanup', async () => {
      rendererGeometry = await orcaPage.evaluate(() => {
        document.dispatchEvent(
          new CustomEvent('orca-lineage-diagnostic-mark', { detail: 'test-ended' })
        )
        return Reflect.get(window, '__lineageScrollDiagnostic') ?? { missing: true }
      })
    })
    await captureDiagnosticEvidence('post-action-window-state', async () => {
      const end = await electronApp.evaluate(({ BrowserWindow }) => ({
        backgroundLaunch: process.env.ORCA_BACKGROUND_LAUNCH,
        headless: process.env.ORCA_E2E_HEADLESS,
        windows: BrowserWindow.getAllWindows().map((window) => ({
          visible: window.isVisible(),
          focused: window.isFocused()
        }))
      }))
      launchAtEnd = end
      if (
        end.backgroundLaunch !== '1' ||
        end.headless !== '1' ||
        end.windows.length === 0 ||
        end.windows.some((window) => window.visible || window.focused)
      ) {
        throw new Error(
          'Diagnostic violated actual background/headless and hidden/unfocused postcondition'
        )
      }
    })
    await captureDiagnosticEvidence('final-screenshot', async () => {
      const screenshotPath = testInfo.outputPath('lineage-diagnostic-final.png')
      await orcaPage.screenshot({ path: screenshotPath })
      await testInfo.attach('lineage-diagnostic-final', {
        path: screenshotPath,
        contentType: 'image/png'
      })
    })
    await captureDiagnosticEvidence('renderer-trace', async () => {
      const tracePath = testInfo.outputPath('lineage-diagnostic-renderer-trace.zip')
      await orcaPage.context().tracing.stop({ path: tracePath })
      await testInfo.attach('lineage-diagnostic-renderer-trace', {
        path: tracePath,
        contentType: 'application/zip'
      })
    })
    await captureDiagnosticEvidence('diagnostic-json', async () => {
      const diagnostic = {
        productSourceHead: '8e499dc8d81965a53be375b5713eabf77dd52a5a',
        diagnosticSpec: 'tests/e2e/pr24165-scroll-diagnosis.spec.ts',
        processBackgroundLaunch: process.env.ORCA_BACKGROUND_LAUNCH,
        launchAtStart,
        launchAtEnd,
        caseName: scenario.name,
        originalBaseline: scenario.baseline,
        primaryFailure:
          primaryFailure instanceof Error
            ? { message: primaryFailure.message, stack: primaryFailure.stack }
            : primaryFailure === undefined
              ? null
              : String(primaryFailure),
        captureFailures,
        rendererGeometry
      }
      console.log('LINEAGE_SCROLL_DIAGNOSTIC', JSON.stringify(diagnostic))
      await testInfo.attach('lineage-scroll-diagnostic', {
        body: Buffer.from(JSON.stringify(diagnostic, null, 2)),
        contentType: 'application/json'
      })
    })
    if (captureFailures.length > 0) {
      console.log('LINEAGE_DIAGNOSTIC_CAPTURE_FAILURES', JSON.stringify(captureFailures))
    }
  }
  if (primaryFailure !== undefined) {
    throw primaryFailure
  }
  if (captureFailures.length > 0) {
    throw new Error(`Diagnostic evidence capture failed: ${JSON.stringify(captureFailures)}`)
  }
}

test('keyboard and chip preserve the scrolled parent, and unfolding opens the sidebar', async ({
  orcaPage,
  electronApp
}, testInfo) => {
  const scenario: ScrollDiagnosticCase = { name: 'original-keyboard-flow' }
  await runScrollDiagnostic(orcaPage, electronApp, testInfo, scenario, async () => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    expect(
      await electronApp.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().every((window) => !window.isVisible())
      )
    ).toBe(true)
    await orcaPage.emulateMedia({ reducedMotion: 'reduce' })
    await orcaPage.setViewportSize({ width: 1200, height: 800 })
    const family = await seedScrolledFamily(orcaPage)

    const sidebar = orcaPage.locator('[data-worktree-sidebar]')
    const parentRow = sidebar
      .locator(`[role="option"][data-worktree-id=${JSON.stringify(family.parentId)}]`)
      .first()
    const childRow = sidebar
      .locator(`[role="option"][data-worktree-id=${JSON.stringify(family.childId)}]`)
      .first()
    await observeScrollLayout(orcaPage, family)
    await orcaPage.getByRole('button', { name: 'Reveal active workspace' }).click()
    await expect(parentRow).toBeVisible()
    await markScrollPhase(orcaPage, 'before-center')
    await parentRow.evaluate((row) => row.scrollIntoView({ block: 'center' }))
    await expect.poll(() => sidebar.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
    const geometry = () =>
      parentRow.evaluate((row) => ({
        top: row.getBoundingClientRect().top,
        scrollTop: row.closest('[data-worktree-sidebar]')?.scrollTop ?? 0
      }))
    const before = await geometry()
    scenario.baseline = before
    console.log('LINEAGE_ORIGINAL_BASELINE', JSON.stringify(before))
    await markScrollPhase(orcaPage, 'baseline-captured')
    await orcaPage.mouse.move(1150, 400)
    await markScrollPhase(orcaPage, 'independent-pre-key')
    await orcaPage.keyboard.press('ControlOrMeta+Alt+KeyH')
    await markScrollPhase(orcaPage, 'keyboard-sent')
    await expect(childRow).toBeHidden()
    await markScrollPhase(orcaPage, 'child-hidden')
    await expect.poll(async () => Math.abs((await geometry()).top - before.top)).toBeLessThan(2)
    expect((await geometry()).scrollTop).toBeGreaterThan(0)
    const collapsedProof = testInfo.outputPath('keyboard-collapsed-parent-anchor.png')
    await sidebar.screenshot({ path: collapsedProof })
    await testInfo.attach('keyboard-collapsed-parent-anchor', {
      path: collapsedProof,
      contentType: 'image/png'
    })

    await markScrollPhase(orcaPage, 'before-chip-click')
    await parentRow.getByRole('button', { name: 'Show 1 child workspace' }).click()
    await expect(childRow).toBeVisible()
    await markScrollPhase(orcaPage, 'child-visible')
    await expect.poll(async () => Math.abs((await geometry()).top - before.top)).toBeLessThan(2)
    await orcaPage.mouse.move(1150, 400)
    await markScrollPhase(orcaPage, 'independent-pre-key')
    await orcaPage.keyboard.press('ControlOrMeta+Alt+KeyH')
    await markScrollPhase(orcaPage, 'keyboard-sent')
    await expect(childRow).toBeHidden()
    await markScrollPhase(orcaPage, 'child-hidden')
    await orcaPage.evaluate(() => window.__store?.getState().setSidebarOpen(false))
    await expect(sidebar).toBeHidden()
    await orcaPage.keyboard.press('ControlOrMeta+Alt+KeyH')
    await markScrollPhase(orcaPage, 'keyboard-sent')
    await expect(sidebar).toBeVisible()
    await expect(childRow).toBeVisible()
  })
})

test('fresh chip control preserves the independently scrolled parent', async ({
  orcaPage,
  electronApp
}, testInfo) => {
  const scenario: ScrollDiagnosticCase = { name: 'fresh-chip-control' }
  await runScrollDiagnostic(orcaPage, electronApp, testInfo, scenario, async () => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    expect(
      await electronApp.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().every((window) => !window.isVisible())
      )
    ).toBe(true)
    await orcaPage.emulateMedia({ reducedMotion: 'reduce' })
    await orcaPage.setViewportSize({ width: 1200, height: 800 })
    const family = await seedScrolledFamily(orcaPage)

    const sidebar = orcaPage.locator('[data-worktree-sidebar]')
    const parentRow = sidebar
      .locator(`[role="option"][data-worktree-id=${JSON.stringify(family.parentId)}]`)
      .first()
    const childRow = sidebar
      .locator(`[role="option"][data-worktree-id=${JSON.stringify(family.childId)}]`)
      .first()
    await observeScrollLayout(orcaPage, family)
    await orcaPage.getByRole('button', { name: 'Reveal active workspace' }).click()
    await expect(parentRow).toBeVisible()
    await markScrollPhase(orcaPage, 'before-center')
    await parentRow.evaluate((row) => row.scrollIntoView({ block: 'center' }))
    await expect.poll(() => sidebar.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
    const geometry = () =>
      parentRow.evaluate((row) => ({
        top: row.getBoundingClientRect().top,
        scrollTop: row.closest('[data-worktree-sidebar]')?.scrollTop ?? 0
      }))
    const before = await geometry()
    scenario.baseline = before
    console.log('LINEAGE_ORIGINAL_BASELINE', JSON.stringify(before))
    await markScrollPhase(orcaPage, 'baseline-captured')
    await markScrollPhase(orcaPage, 'fresh-chip-before-fold')
    await parentRow.getByRole('button', { name: 'Hide 1 child workspace' }).click()
    await expect(childRow).toBeHidden()
    await markScrollPhase(orcaPage, 'fresh-chip-after-fold')
    await expect.poll(async () => Math.abs((await geometry()).top - before.top)).toBeLessThan(2)
    expect((await geometry()).scrollTop).toBeGreaterThan(0)
    await markScrollPhase(orcaPage, 'fresh-chip-before-unfold')
    await parentRow.getByRole('button', { name: 'Show 1 child workspace' }).click()
    await expect(childRow).toBeVisible()
    await markScrollPhase(orcaPage, 'fresh-chip-after-unfold')
    await expect.poll(async () => Math.abs((await geometry()).top - before.top)).toBeLessThan(2)
  })
})
