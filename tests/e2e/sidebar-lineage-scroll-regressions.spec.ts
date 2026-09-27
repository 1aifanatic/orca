import { writeFile } from 'node:fs/promises'
import { test, expect } from './sidebar-animation-fixture'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  seedOrdinaryRowsAboveLineage,
  seedVirtualLineage
} from './sidebar-lineage-virtualization-state'
import { seedWorkspaceAgentStatus } from './worktree-lineage-state'
import { expectSidebarScrollProgress, measureSidebarScroll } from './sidebar-scroll-timeline'
import { worktreeRow } from './worktree-row-locators'

test('lineage descendants keep their anchor when an ordinary card above grows during suppression', async ({
  orcaPage
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await seedVirtualLineage(orcaPage, false)
  await expect(worktreeRow(orcaPage, 'e2e-virtual-child-0')).toBeInViewport()
  await seedOrdinaryRowsAboveLineage(orcaPage)
  await orcaPage.waitForTimeout(650)
  await orcaPage.evaluate(() => {
    window
      .__store!.getState()
      .revealWorktreeInSidebar('e2e-virtual-child-200', { behavior: 'auto' })
  })
  const targetId = 'e2e-virtual-child-200'
  const target = worktreeRow(orcaPage, targetId)
  await expect(target).toBeAttached()
  await target.evaluate((element) => {
    const scroller = element.closest<HTMLElement>('[data-worktree-sidebar]')!
    scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: 1, bubbles: true }))
    scroller.scrollTop +=
      element.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 40
  })
  await orcaPage.waitForTimeout(650)
  await expect(target).toBeInViewport()
  const previousTop = (await target.boundingBox())!.y
  const above = worktreeRow(orcaPage, 'ordinary-79')
  const previousHeight = (await above.boundingBox())!.height
  const scroller = orcaPage.locator('[data-worktree-sidebar]')
  const before = await scroller.evaluate((element) => {
    element.dispatchEvent(new Event('orca-record-virtualized-scroll-anchor'))
    element.dispatchEvent(new Event('scroll'))
    const group = element.querySelector<HTMLElement>(
      '[data-worktree-virtual-row-key^="lineage-group:"]'
    )!
    return {
      scrollTop: element.scrollTop,
      groupTop: group.getBoundingClientRect().top - element.getBoundingClientRect().top,
      groupBottom: group.getBoundingClientRect().bottom - element.getBoundingClientRect().top
    }
  })
  expect(before.groupTop).toBeLessThan(0)
  expect(before.groupBottom).toBeGreaterThan(0)
  expect((await above.boundingBox())!.y + previousHeight).toBeLessThan(
    (await scroller.boundingBox())!.y
  )
  await seedWorkspaceAgentStatus(orcaPage, 'ordinary-79', 'ABOVE_LINEAGE_HEIGHT')
  await expect
    .poll(async () => (await above.boundingBox())!.height)
    .toBeGreaterThan(previousHeight + 10)
  await orcaPage.waitForTimeout(650)
  const after = await scroller.evaluate((element) => element.scrollTop)
  const drift = (await target.boundingBox())!.y - previousTop
  await writeFile(
    testInfo.outputPath('above-lineage-growth.json'),
    JSON.stringify({ targetId, before, after, drift })
  )
  expect(Math.abs(drift)).toBeLessThan(2)
  await orcaPage.screenshot({ path: testInfo.outputPath('above-lineage-growth.png') })
})

test('ordinary rows keep their anchor during measurement suppression with a distant lineage', async ({
  orcaPage
}) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await seedVirtualLineage(orcaPage, false)
  await seedOrdinaryRowsAboveLineage(orcaPage)
  await orcaPage.evaluate(() => {
    window.__store!.getState().revealWorktreeInSidebar('ordinary-30', { behavior: 'auto' })
  })
  const target = worktreeRow(orcaPage, 'ordinary-30')
  await expect(target).toBeInViewport()
  await target.evaluate((element) => {
    const scroller = element.closest<HTMLElement>('[data-worktree-sidebar]')!
    scroller.scrollTop +=
      element.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 40
  })
  await orcaPage.waitForTimeout(650)
  const previousTop = (await target.boundingBox())!.y
  const above = worktreeRow(orcaPage, 'ordinary-24')
  const previousHeight = (await above.boundingBox())!.height
  await orcaPage.locator('[data-worktree-sidebar]').evaluate((element) => {
    element.dispatchEvent(new Event('orca-record-virtualized-scroll-anchor'))
    element.dispatchEvent(new Event('scroll'))
  })
  await seedWorkspaceAgentStatus(orcaPage, 'ordinary-24', 'MIXED_HEIGHT')
  await expect
    .poll(async () => (await above.boundingBox())!.height)
    .toBeGreaterThan(previousHeight + 10)
  await expect
    .poll(async () => Math.abs((await target.boundingBox())!.y - previousTop))
    .toBeLessThan(2)
})

const revealScenarios = (['worktree', 'sidebar-row', 'rename'] as const).flatMap((requestKind) =>
  [100, 150, 400].flatMap((targetIndex) =>
    [0, 800].map((idleMs) => ({ requestKind, targetIndex, idleMs }))
  )
)

for (const { requestKind, targetIndex, idleMs } of revealScenarios) {
  test(`smooth ${requestKind} reveal child ${targetIndex} after ${idleMs}ms idle keeps the inactive descendant mounted until its title lands`, async ({
    orcaPage
  }, testInfo) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await seedVirtualLineage(orcaPage, requestKind === 'sidebar-row')
    await expect(worktreeRow(orcaPage, 'e2e-virtual-child-0')).toBeVisible()
    await orcaPage.waitForTimeout(idleMs)
    await orcaPage.emulateMedia({ reducedMotion: 'no-preference' })
    const result = await orcaPage.evaluate(
      async ({ requestKind, targetIndex }) => {
        const targetId = `e2e-virtual-child-${targetIndex}`
        const scroller = document.querySelector<HTMLElement>('[data-worktree-sidebar]')!
        const samples: {
          time: number
          mounted: boolean
          top: number | null
          height: number | null
          scrollTop: number
        }[] = []
        const startedAt = performance.now()
        const initialOffset = scroller.scrollTop
        const state = window.__store!.getState()
        if (requestKind === 'sidebar-row') {
          const firstKey = scroller.querySelector<HTMLElement>(
            '[data-worktree-id="e2e-virtual-child-0"]'
          )!.dataset.worktreeRowKey!
          state.revealSidebarRow(firstKey.replace('e2e-virtual-child-0', targetId), {
            behavior: 'smooth',
            highlight: false
          })
        } else {
          state.revealWorktreeInSidebar(targetId, {
            behavior: 'smooth',
            highlight: true,
            beginRename: requestKind === 'rename'
          })
        }
        while (performance.now() - startedAt < 1_800) {
          await new Promise(requestAnimationFrame)
          const target = scroller.querySelector<HTMLElement>(`[data-worktree-id="${targetId}"]`)
          samples.push({
            time: performance.now() - startedAt,
            mounted: target !== null,
            height: target?.getBoundingClientRect().height ?? null,
            top: target
              ? target.getBoundingClientRect().top - scroller.getBoundingClientRect().top
              : null,
            scrollTop: scroller.scrollTop
          })
        }
        return {
          samples,
          initialOffset,
          requestKind,
          targetIndex,
          sidebarHeight: scroller.clientHeight
        }
      },
      { requestKind, targetIndex }
    )
    const frames = result.samples
    const metrics = measureSidebarScroll(frames, result.initialOffset)
    const mountedIntermediate = frames.filter(
      (frame) =>
        frame.mounted &&
        frame.scrollTop > result.initialOffset &&
        frame.scrollTop < metrics.finalOffset - 2
    ).length
    console.log(
      '[sidebar-smooth-retention]',
      JSON.stringify({
        requestKind,
        targetIndex,
        idleMs,
        ...metrics,
        mountedIntermediate,
        sidebarHeight: result.sidebarHeight
      })
    )
    await writeFile(
      testInfo.outputPath('smooth-reveal-frames.json'),
      JSON.stringify({ ...result, idleMs, ...metrics, mountedIntermediate }, null, 2)
    )
    expectSidebarScrollProgress(metrics)
    expect(metrics.longestPause, 'no stalled approach').toBeLessThan(200)
    expect(metrics.arrivalMs, 'landing within the measured base latency envelope').toBeLessThan(
      1_700
    )
    const backwardStep = Math.max(
      ...frames.map(
        (frame, index) => (frames[index - 1]?.scrollTop ?? frame.scrollTop) - frame.scrollTop
      )
    )
    expect(backwardStep, 'no backtracking toward the measured target').toBeLessThanOrEqual(2)
    const firstVisible = frames.findIndex(
      (frame) => frame.top !== null && frame.top >= 0 && frame.top < result.sidebarHeight
    )
    expect(firstVisible).toBeGreaterThanOrEqual(0)
    expect(
      frames
        .slice(firstVisible)
        .every((frame) => frame.top !== null && frame.top >= 0 && frame.top < result.sidebarHeight),
      'target stays in view after first arrival'
    ).toBe(true)
    expect(
      mountedIntermediate,
      'target retained during intermediate motion'
    ).toBeGreaterThanOrEqual(3)
    const firstMounted = frames.findIndex((frame) => frame.mounted)
    expect(firstMounted).toBeGreaterThanOrEqual(0)
    expect(frames.slice(firstMounted).every((frame) => frame.mounted)).toBe(true)
    const target = worktreeRow(orcaPage, `e2e-virtual-child-${targetIndex}`)
    if (requestKind === 'rename') {
      await expect(target.getByRole('textbox')).toBeInViewport()
      await expect(target.getByRole('textbox')).toHaveValue(`Virtual child ${targetIndex}`)
    } else {
      await expect(
        target.getByText(`Virtual child ${targetIndex}`, { exact: true })
      ).toBeInViewport()
    }
    if (requestKind === 'worktree') {
      await expect(target).toHaveAttribute('data-scroll-reveal-highlight', 'true')
    }
    const landedTop = (await target.boundingBox())!.y
    await orcaPage.waitForTimeout(350)
    await expect(target).toBeInViewport()
    expect(Math.abs((await target.boundingBox())!.y - landedTop)).toBeLessThan(2)
    await orcaPage.screenshot({ path: testInfo.outputPath('smooth-reveal-landed.png') })
  })
}
