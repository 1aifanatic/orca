import { writeFile } from 'node:fs/promises'
import { test, expect } from './sidebar-animation-fixture'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { seedVirtualLineage } from './sidebar-lineage-virtualization-state'
import { worktreeRow } from './worktree-row-locators'

for (const scenario of [
  'churn-worktree',
  'churn-row',
  'up',
  'down-measured',
  'oversized'
] as const) {
  test(`native reveal continuity: ${scenario}`, async ({ orcaPage }, testInfo) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await seedVirtualLineage(orcaPage, false)
    await orcaPage.waitForTimeout(800)
    await orcaPage.emulateMedia({ reducedMotion: 'no-preference' })
    if (scenario === 'oversized') {
      await orcaPage.addStyleTag({
        content: '[data-worktree-id="e2e-virtual-child-150"] { min-height: 1200px; }'
      })
    }
    if (scenario === 'up' || scenario === 'down-measured') {
      await orcaPage.evaluate(() =>
        window.__store!.getState().revealWorktreeInSidebar('e2e-virtual-child-499', {
          behavior: 'smooth',
          highlight: false
        })
      )
      await expect
        .poll(() => orcaPage.evaluate(() => window.__store!.getState().pendingRevealWorktree))
        .toBeNull()
      if (scenario === 'down-measured') {
        await orcaPage.evaluate(() =>
          window.__store!.getState().revealWorktreeInSidebar('e2e-virtual-child-0', {
            behavior: 'smooth',
            highlight: false
          })
        )
        await expect
          .poll(() => orcaPage.evaluate(() => window.__store!.getState().pendingRevealWorktree))
          .toBeNull()
      }
    }
    const result = await orcaPage.evaluate(async (scenario) => {
      const scroller = document.querySelector<HTMLElement>('[data-worktree-sidebar]')!
      const targetId =
        scenario === 'down-measured' ? 'e2e-virtual-child-350' : 'e2e-virtual-child-150'
      const original = Object.getOwnPropertyDescriptor(scroller, 'scrollTo')
      const scrollTo = scroller.scrollTo.bind(scroller)
      const start = performance.now()
      const writes: { time: number; top: number; from: number; behavior?: string }[] = []
      const samples: { time: number; offset: number; top: number | null; pending: boolean }[] = []
      scroller.scrollTo = (options?: ScrollToOptions | number, y?: number) => {
        if (typeof options === 'number') {
          scrollTo(options, y ?? 0)
        } else {
          writes.push({
            time: performance.now() - start,
            from: scroller.scrollTop,
            top: options?.top ?? scroller.scrollTop,
            behavior: options?.behavior
          })
          scrollTo(options)
        }
      }
      let updates = 0
      let completedAt: number | null = null
      try {
        const store = window.__store!
        if (scenario === 'churn-row') {
          const first = scroller.querySelector<HTMLElement>(
            '[data-worktree-id="e2e-virtual-child-0"]'
          )!
          store
            .getState()
            .revealSidebarRow(
              first.dataset.worktreeRowKey!.replace('e2e-virtual-child-0', targetId),
              { behavior: 'smooth', highlight: true }
            )
        } else {
          store
            .getState()
            .revealWorktreeInSidebar(targetId, { behavior: 'smooth', highlight: true })
        }
        while (performance.now() - start < 4_000) {
          await new Promise(requestAnimationFrame)
          const time = performance.now() - start
          if (scenario.startsWith('churn') && updates < 12 && time >= 300 + updates * 120) {
            const state = store.getState()
            store.setState({
              worktreesByRepo: { ...state.worktreesByRepo },
              workspaceStatuses: [...state.workspaceStatuses]
            })
            updates++
          }
          const target = scroller.querySelector<HTMLElement>(`[data-worktree-id="${targetId}"]`)
          const pending =
            store.getState().pendingRevealWorktree !== null ||
            store.getState().pendingRevealSidebarRow !== null
          samples.push({
            time,
            offset: scroller.scrollTop,
            pending,
            top: target
              ? target.getBoundingClientRect().top - scroller.getBoundingClientRect().top
              : null
          })
          if (!pending && completedAt === null) {
            completedAt = time
          }
          if (
            completedAt !== null &&
            time > completedAt + 350 &&
            (!scenario.startsWith('churn') || updates === 12)
          ) {
            break
          }
        }
        return { writes, samples, updates, completedAt, targetId }
      } finally {
        if (original) {
          Object.defineProperty(scroller, 'scrollTo', original)
        } else {
          Reflect.deleteProperty(scroller, 'scrollTo')
        }
      }
    }, scenario)
    await writeFile(testInfo.outputPath('continuity.json'), JSON.stringify(result, null, 2))
    console.log(
      '[reveal-continuity]',
      JSON.stringify({
        scenario,
        completedAt: result.completedAt,
        smoothWrites: result.writes.filter((write) => write.behavior === 'smooth').length,
        maxAutoJump: Math.max(
          0,
          ...result.writes
            .filter((write) => write.behavior === 'auto')
            .map((write) => Math.abs(write.top - write.from))
        )
      })
    )
    expect(result.completedAt).not.toBeNull()
    expect(result.samples.at(-1)?.pending).toBe(false)
    if (scenario.startsWith('churn')) {
      expect(result.updates).toBe(12)
      // Geometry retargets remain allowed; twelve unchanged-data updates cannot restart easing.
      expect(result.writes.filter((write) => write.behavior === 'smooth').length).toBeLessThan(8)
      expect(result.completedAt).toBeLessThan(1_700)
    } else {
      const finalAutoWrites = result.writes.filter(
        (write) => write.behavior === 'auto' && write.time > 300
      )
      expect(
        finalAutoWrites.every((write) => Math.abs(write.top - write.from) <= 2),
        'native easing finishes before correction'
      ).toBe(true)
    }
    await expect(worktreeRow(orcaPage, result.targetId)).toBeInViewport()
    if (scenario === 'oversized') {
      const card = worktreeRow(orcaPage, result.targetId)
      await expect(card.getByText('Virtual child 150', { exact: true })).toBeInViewport()
      expect(Math.abs((result.samples.at(-1)?.top ?? Infinity) - 34)).toBeLessThanOrEqual(2)
      expect((await card.boundingBox())!.height).toBeGreaterThan(1_000)
    }
    const landed = result.samples.filter((sample) => sample.time >= result.completedAt!)
    expect(
      Math.max(...landed.map((sample) => sample.offset)) -
        Math.min(...landed.map((sample) => sample.offset))
    ).toBeLessThanOrEqual(2)
    await orcaPage.screenshot({ path: testInfo.outputPath('landed.png') })
  })
}
