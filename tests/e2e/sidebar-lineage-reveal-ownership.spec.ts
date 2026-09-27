import { writeFile } from 'node:fs/promises'
import { test, expect } from './sidebar-animation-fixture'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { seedVirtualLineage } from './sidebar-lineage-virtualization-state'
import { worktreeRow } from './worktree-row-locators'

for (const [firstKind, secondKind, firstIndex, secondIndex] of [
  ['worktree', 'worktree', 400, 100],
  ['worktree', 'sidebar-row', 400, 100],
  ['sidebar-row', 'worktree', 400, 100],
  ['worktree', 'worktree', 150, 150]
] as const) {
  test(`new ${secondKind} ${secondIndex} reveal replaces in-flight ${firstKind} ${firstIndex}`, async ({
    orcaPage
  }, testInfo) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await seedVirtualLineage(orcaPage, false)
    await expect(worktreeRow(orcaPage, 'e2e-virtual-child-0')).toBeInViewport()
    await orcaPage.waitForTimeout(800)
    await orcaPage.emulateMedia({ reducedMotion: 'no-preference' })
    const result = await orcaPage.evaluate(
      async ({ firstKind, secondKind, firstIndex, secondIndex }) => {
        const scroller = document.querySelector<HTMLElement>('[data-worktree-sidebar]')!
        const firstKey = scroller.querySelector<HTMLElement>(
          '[data-worktree-id="e2e-virtual-child-0"]'
        )!.dataset.worktreeRowKey!
        const request = (kind: 'worktree' | 'sidebar-row', index: number) => {
          const state = window.__store!.getState()
          const id = `e2e-virtual-child-${index}`
          if (kind === 'worktree') {
            state.revealWorktreeInSidebar(id, { behavior: 'smooth', highlight: true })
          } else {
            state.revealSidebarRow(firstKey.replace('e2e-virtual-child-0', id), {
              behavior: 'smooth',
              highlight: true
            })
          }
        }
        request(firstKind, firstIndex)
        await new Promise((resolve) => setTimeout(resolve, 200))
        const beforeReplacement = scroller.scrollTop
        await new Promise(requestAnimationFrame)
        const atReplacement = {
          before: beforeReplacement,
          offset: scroller.scrollTop,
          pending:
            firstKind === 'worktree'
              ? window.__store!.getState().pendingRevealWorktree?.worktreeId
              : window.__store!.getState().pendingRevealSidebarRow?.rowKey
        }
        request(secondKind, secondIndex)
        const start = performance.now()
        const samples: { time: number; top: number | null; scrollTop: number }[] = []
        while (performance.now() - start < 1_800) {
          await new Promise(requestAnimationFrame)
          const target = scroller.querySelector<HTMLElement>(
            `[data-worktree-id="e2e-virtual-child-${secondIndex}"]`
          )
          samples.push({
            time: performance.now() - start,
            scrollTop: scroller.scrollTop,
            top: target
              ? target.getBoundingClientRect().top - scroller.getBoundingClientRect().top
              : null
          })
        }
        const state = window.__store!.getState()
        return {
          samples,
          atReplacement,
          pendingWorktree: state.pendingRevealWorktree,
          pendingRow: state.pendingRevealSidebarRow
        }
      },
      { firstKind, secondKind, firstIndex, secondIndex }
    )
    await writeFile(testInfo.outputPath('replacement-frames.json'), JSON.stringify(result, null, 2))
    expect(result.atReplacement.pending).toBeTruthy()
    expect(result.atReplacement.offset).toBeGreaterThan(0)
    expect(result.atReplacement.offset).not.toBe(result.atReplacement.before)
    expect(
      Math.max(...result.samples.map((sample) => sample.scrollTop)) -
        result.samples.at(-1)!.scrollTop,
      'superseded destination cannot pull the scroller past its new target'
    ).toBeLessThanOrEqual(2)
    expect(result.pendingWorktree).toBeNull()
    expect(result.pendingRow).toBeNull()
    const target = worktreeRow(orcaPage, `e2e-virtual-child-${secondIndex}`)
    await expect(target.getByText(`Virtual child ${secondIndex}`, { exact: true })).toBeInViewport()
    await expect(target).toHaveAttribute('data-scroll-reveal-highlight', 'true')
    const top = (await target.boundingBox())!.y
    await orcaPage.waitForTimeout(350)
    expect(Math.abs((await target.boundingBox())!.y - top)).toBeLessThan(2)
  })
}

test('smooth reveal reaches the last descendant and returns to the first', async ({ orcaPage }) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await seedVirtualLineage(orcaPage, false)
  await expect(worktreeRow(orcaPage, 'e2e-virtual-child-0')).toBeInViewport()
  await orcaPage.waitForTimeout(800)
  await orcaPage.emulateMedia({ reducedMotion: 'no-preference' })
  for (const index of [499, 0]) {
    await orcaPage.evaluate((index) => {
      window.__store!.getState().revealWorktreeInSidebar(`e2e-virtual-child-${index}`, {
        behavior: 'smooth',
        highlight: true
      })
    }, index)
    await orcaPage.waitForTimeout(1_800)
    const target = worktreeRow(orcaPage, `e2e-virtual-child-${index}`)
    await expect(target.getByText(`Virtual child ${index}`, { exact: true })).toBeInViewport()
    await expect(target).toHaveAttribute('data-scroll-reveal-highlight', 'true')
    expect(
      await orcaPage.evaluate(() => window.__store!.getState().pendingRevealWorktree)
    ).toBeNull()
  }
})

for (const interruption of ['wheel', 'cancel'] as const) {
  test(`${interruption} during the measured approach prevents delayed reveal writes`, async ({
    orcaPage
  }, testInfo) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await seedVirtualLineage(orcaPage, false)
    await expect(worktreeRow(orcaPage, 'e2e-virtual-child-0')).toBeInViewport()
    await orcaPage.waitForTimeout(800)
    await orcaPage.emulateMedia({ reducedMotion: 'no-preference' })
    const result = await orcaPage.evaluate(async (interruption) => {
      const scroller = document.querySelector<HTMLElement>('[data-worktree-sidebar]')!
      const originalScrollTo = scroller.scrollTo.bind(scroller)
      let smoothWrites = 0
      scroller.scrollTo = (options?: ScrollToOptions | number, y?: number) => {
        if (typeof options === 'number') {
          originalScrollTo(options, y ?? 0)
        } else {
          if (options?.behavior === 'smooth') {
            smoothWrites++
          }
          originalScrollTo(options)
        }
      }
      window.__store!.getState().revealWorktreeInSidebar('e2e-virtual-child-150', {
        behavior: 'smooth',
        highlight: true
      })
      const startedAt = performance.now()
      let previousOffset = scroller.scrollTop
      let moving = false
      while (performance.now() - startedAt < 1_500) {
        await new Promise(requestAnimationFrame)
        moving = Math.abs(scroller.scrollTop - previousOffset) > 1
        if (smoothWrites >= 2 && moving) {
          break
        }
        previousOffset = scroller.scrollTop
      }
      const atInterruption = {
        smoothWrites,
        moving,
        offset: scroller.scrollTop,
        pending: window.__store!.getState().pendingRevealWorktree?.worktreeId
      }
      if (interruption === 'wheel') {
        scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -200, bubbles: true }))
      } else {
        window.__store!.getState().clearPendingRevealWorktreeId()
      }
      scroller.scrollTo({ top: scroller.scrollTop - 200, behavior: 'instant' })
      await new Promise(requestAnimationFrame)
      const offset = scroller.scrollTop
      const start = performance.now()
      const samples: { time: number; scrollTop: number; highlighted: boolean }[] = []
      while (performance.now() - start < 1_200) {
        await new Promise(requestAnimationFrame)
        const target = scroller.querySelector('[data-worktree-id="e2e-virtual-child-150"]')
        samples.push({
          time: performance.now() - start,
          scrollTop: scroller.scrollTop,
          highlighted: target?.getAttribute('data-scroll-reveal-highlight') === 'true'
        })
      }
      scroller.scrollTo = originalScrollTo
      return {
        offset,
        samples,
        atInterruption,
        pending: window.__store!.getState().pendingRevealWorktree
      }
    }, interruption)
    await writeFile(
      testInfo.outputPath('interruption-frames.json'),
      JSON.stringify(result, null, 2)
    )
    expect(result.atInterruption.pending).toBe('e2e-virtual-child-150')
    expect(result.atInterruption.smoothWrites).toBeGreaterThanOrEqual(2)
    expect(result.atInterruption.moving).toBe(true)
    expect(result.pending).toBeNull()
    expect(result.samples.every((sample) => !sample.highlighted)).toBe(true)
    expect(
      Math.max(...result.samples.map((sample) => Math.abs(sample.scrollTop - result.offset)))
    ).toBeLessThan(2)
  })
}
