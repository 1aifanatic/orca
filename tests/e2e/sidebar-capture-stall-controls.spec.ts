import { writeFile } from 'node:fs/promises'
import { test, expect } from './sidebar-animation-fixture'
import type { Page } from '@stablyai/playwright-test'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { seedVirtualLineage } from './sidebar-lineage-virtualization-state'
import { measureSidebarScroll } from './sidebar-scroll-timeline'

type ControlScenario = 'stationary' | 'moving'

async function collectControl(page: Page, scenario: ControlScenario) {
  await waitForSessionReady(page)
  await waitForActiveWorktree(page)
  await seedVirtualLineage(page, false)
  await page.waitForTimeout(800)
  return page.evaluate(async (scenario) => {
    const scroller = document.querySelector<HTMLElement>('[data-worktree-sidebar]')!
    const store = window.__store!
    const targetId = 'e2e-virtual-child-150'
    const nextFrame = (timeoutMs: number) => new Promise<boolean>((resolve) => {
      let settled = false
      let frame = 0
      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true
          cancelAnimationFrame(frame)
          resolve(false)
        }
      }, timeoutMs)
      frame = requestAnimationFrame(() => {
        if (!settled) {
          settled = true
          clearTimeout(timeout)
          resolve(true)
        }
      })
    })
    let warmupTimedOut = false
    if (scenario === 'moving') {
      store.getState().revealWorktreeInSidebar('e2e-virtual-child-499', { behavior: 'smooth', highlight: false })
      const warmupStart = performance.now()
      while (store.getState().pendingRevealWorktree !== null && performance.now() - warmupStart < 4_500) {
        if (!(await nextFrame(1_000))) {
          warmupTimedOut = true
          break
        }
      }
      if (store.getState().pendingRevealWorktree !== null) warmupTimedOut = true
      if (!warmupTimedOut && !(await nextFrame(1_000))) warmupTimedOut = true
    }
    const initialOffset = scroller.scrollTop
    const start = performance.now()
    const samples: { time: number; epochMs: number; scrollTop: number; geometry: { top: number; height: number; viewportHeight: number; contentTop: number; contentHeight: number; contentVisible: boolean } | null; pending: boolean }[] = []
    const timerTicks: { time: number; epochMs: number }[] = []
    const longTasks: { startTime: number; epochMs: number; duration: number }[] = []
    const timer = setInterval(() => {
      const time = performance.now() - start
      timerTicks.push({ time, epochMs: performance.timeOrigin + start + time })
    }, 50)
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        longTasks.push({ startTime: entry.startTime, epochMs: performance.timeOrigin + entry.startTime, duration: entry.duration })
      }
    })
    observer.observe({ type: 'longtask', buffered: true })
    // The moving control needs bracketing ticks before the block; wait for the timer to prove it runs.
    while (timerTicks.length < 3 && performance.now() - start < 1_000) {
      if (!(await nextFrame(1_000))) break
    }
    const ticksBeforeReveal = timerTicks.length
    store.getState().revealWorktreeInSidebar(targetId, { behavior: 'smooth', highlight: false })
    let blocked = false
    let captureTimedOut = false
    let settledBeforeBlock = false
    let movingReady: { samples: number; ticks: number; geometryStepPx: number; offsetStepPx: number; offsetFromInitialPx: number } | null = null
    let deliberateStall: { startMs: number; endMs: number; performanceStartMs: number; performanceEndMs: number } | null = null
    let stableSince: number | null = null
    let previousStableVector: number[] | null = null
    while (performance.now() - start < 4_500) {
      if (!(await nextFrame(4_500))) {
        captureTimedOut = true
        break
      }
      const now = performance.now()
      const target = scroller.querySelector<HTMLElement>(`[data-worktree-id="${targetId}"]`)
      const content = target?.querySelector<HTMLElement>('[data-worktree-title-inline-rename]')
      const rect = target?.getBoundingClientRect()
      const contentRect = content?.getBoundingClientRect()
      const scrollerRect = scroller.getBoundingClientRect()
      const viewportTop = scrollerRect.top + scroller.clientTop
      const pending = store.getState().pendingRevealWorktree !== null
      const targetVisible = rect && content && contentRect && rect.top >= viewportTop && rect.bottom <= scrollerRect.bottom && content.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
      const stableVector = targetVisible && rect && contentRect
        ? [scroller.scrollTop, rect.top, rect.height, contentRect.top, contentRect.height]
        : null
      if (scenario === 'stationary' && !pending && stableVector && previousStableVector && stableVector.every((value, index) => Math.abs(value - (previousStableVector?.[index] ?? value)) <= 2)) {
        stableSince ??= now
      } else if (scenario === 'stationary') {
        stableSince = null
      }
      previousStableVector = stableVector
      samples.push({
        time: now - start,
        epochMs: performance.timeOrigin + now,
        scrollTop: scroller.scrollTop,
        geometry: rect && content && contentRect ? {
          top: rect.top - viewportTop,
          height: rect.height,
          viewportHeight: scroller.clientHeight,
          contentTop: contentRect.top - viewportTop,
          contentHeight: contentRect.height,
          contentVisible: content.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
        } : null,
        pending
      })
      const stableFor350ms = stableSince !== null && now - stableSince >= 350
      // Repaired moving trigger: three samples of observed target motion plus bracketing ticks.
      const previous = samples.at(-2)
      const earlier = samples.at(-3)
      const geometryStepPx = previous?.geometry && earlier?.geometry
        ? Math.abs(previous.geometry.top - earlier.geometry.top)
        : 0
      const offsetStepPx = previous ? Math.abs(scroller.scrollTop - previous.scrollTop) : 0
      const offsetFromInitialPx = Math.abs(scroller.scrollTop - initialOffset)
      const movingReadyNow = pending && samples.length >= 4 && timerTicks.length >= 3 &&
        rect != null && contentRect != null &&
        geometryStepPx > 2 && offsetStepPx > 2 && offsetFromInitialPx > 2
      if (!blocked && (scenario === 'stationary' ? stableFor350ms : movingReadyNow)) {
        settledBeforeBlock = scenario === 'stationary' && stableFor350ms
        if (scenario === 'moving') {
          movingReady = { samples: samples.length, ticks: timerTicks.length, geometryStepPx, offsetStepPx, offsetFromInitialPx }
        }
        const blockStart = performance.now()
        while (performance.now() - blockStart < 250) { /* deliberate main-thread stall */ }
        deliberateStall = { startMs: blockStart - start, endMs: performance.now() - start, performanceStartMs: blockStart, performanceEndMs: performance.now() }
        blocked = true
      }
    }
    clearInterval(timer)
    observer.disconnect()
    return {
      scenario, samples, initialOffset, timerTicks, longTasks, blocked, captureTimedOut,
      warmupTimedOut, settledBeforeBlock, ticksBeforeReveal, movingReady, deliberateStall,
      pageTimeOriginMs: performance.timeOrigin,
      visibility: { state: document.visibilityState, hidden: document.hidden }
    }
  }, scenario)
}

async function runControl(page: Page, outputPath: (name: string) => string, scenario: ControlScenario) {
  const result = await collectControl(page, scenario)
  const metrics = measureSidebarScroll(result.samples, result.initialOffset, {
    captureTimedOut: result.captureTimedOut || result.warmupTimedOut
  })
  const gaps = result.samples.slice(1).map((sample, index) => ({
    gapMs: sample.time - (result.samples[index]?.time ?? 0),
    before: result.samples[index],
    after: sample
  }))
  const maxGap = gaps.reduce((best, gap) => gap.gapMs > best.gapMs ? gap : best, { gapMs: 0, before: result.samples[0], after: result.samples[0] })
  const stallGap = gaps.find((gap) => gap.before && gap.after && result.deliberateStall && gap.before.time <= result.deliberateStall.startMs && gap.after.time >= result.deliberateStall.endMs)
  const lifecycleClearMs = result.samples.find((sample) => !sample.pending)?.time ?? null
  const arm = process.env.ORCA_E2E_SIDEBAR_MOTION_XVFB === '1' ? 'mapped' : 'hidden'
  const offsetAdvancedAcrossStall = stallGap?.before?.scrollTop !== stallGap?.after?.scrollTop
  const geometryAdvancedAcrossStall = stallGap?.before?.geometry?.top !== stallGap?.after?.geometry?.top
  const evidence = {
    scenario, arm, case: process.env.ORCA_E2E_SIDEBAR_CASE ?? null, ...result,
    lifecycleClearMs, metrics, maxGap, stallGap,
    offsetAdvancedAcrossStall, geometryAdvancedAcrossStall
  }
  await writeFile(outputPath(`${scenario}-control.json`), JSON.stringify(evidence, null, 2))
  console.log('[sidebar-capture-control]', JSON.stringify(evidence))
  expect(result.blocked).toBe(true)
  expect(stallGap?.gapMs).toBeGreaterThanOrEqual(200)
  const stall = result.deliberateStall
  expect(stall).not.toBeNull()
  expect(result.longTasks.some((entry) => entry.startTime <= stall!.performanceEndMs && entry.startTime + entry.duration >= stall!.performanceStartMs && entry.duration >= 200)).toBe(true)
  expect(result.timerTicks.some((tick, index) => {
    const before = result.timerTicks[index - 1]
    return before !== undefined && before.time <= stall!.startMs && tick.time >= stall!.endMs && tick.time - before.time >= 200
  })).toBe(true)
  if (scenario === 'stationary') {
    expect(result.settledBeforeBlock).toBe(true)
    expect(stallGap?.before?.scrollTop).toBe(stallGap?.after?.scrollTop)
    expect(Math.abs((stallGap?.before?.geometry?.top ?? Infinity) - (stallGap?.after?.geometry?.top ?? -Infinity))).toBeLessThanOrEqual(2)
    expect(Math.abs((stallGap?.before?.geometry?.contentTop ?? Infinity) - (stallGap?.after?.geometry?.contentTop ?? -Infinity))).toBeLessThanOrEqual(2)
  } else {
    expect(result.movingReady).not.toBeNull()
    expect(metrics.maxFrameGap).toBeGreaterThanOrEqual(200)
    expect(offsetAdvancedAcrossStall).toBe(true)
    expect(geometryAdvancedAcrossStall).toBe(true)
  }
}

test('stationary event-loop control', async ({ orcaPage }, testInfo) => {
  await runControl(orcaPage, (name) => testInfo.outputPath(name), 'stationary')
})

test('moving event-loop control', async ({ orcaPage }, testInfo) => {
  await runControl(orcaPage, (name) => testInfo.outputPath(name), 'moving')
})
