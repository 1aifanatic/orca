/**
 * Diagnostic-only instrumented copy of the maintained lineage smooth-reveal case, for the child-400
 * forward jump and late landing. Assertions, gates and timings are identical to
 * `sidebar-lineage-scroll-regressions.spec.ts`; the only additions are per-sample extent and target
 * geometry, and the scroll-write log from `sidebar-arrival-write-recorder.ts`. The full JSON is
 * written before the assertions run, so a failing case still yields its evidence.
 */
import { writeFile } from 'node:fs/promises'
import { test, expect } from './sidebar-animation-fixture'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { seedVirtualLineage } from './sidebar-lineage-virtualization-state'
import { worktreeRow } from './worktree-row-locators'
import {
  expectSidebarScrollProgress,
  isSidebarScrollIntermediate,
  measureSidebarScroll,
  type SidebarScrollSample
} from './sidebar-scroll-timeline'
import { installArrivalRecorder, type ArrivalWriteLog } from './sidebar-arrival-write-recorder'

const probeScenarios = [
  { targetIndex: 400, idleMs: 0 },
  { targetIndex: 100, idleMs: 0 },
  { targetIndex: 400, idleMs: 800 }
] as const

for (const { targetIndex, idleMs } of probeScenarios) {
  test(`arrival probe: smooth worktree reveal child ${targetIndex} after ${idleMs}ms idle keeps the inactive descendant mounted until its title lands`, async ({
    orcaPage
  }, testInfo) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await seedVirtualLineage(orcaPage, false)
    await expect(worktreeRow(orcaPage, 'e2e-virtual-child-0')).toBeVisible()
    await orcaPage.waitForTimeout(idleMs)
    await orcaPage.emulateMedia({ reducedMotion: 'no-preference' })
    await orcaPage.evaluate(installArrivalRecorder)
    const result = await orcaPage.evaluate(
      async ({ targetIndex }) => {
        const targetId = `e2e-virtual-child-${targetIndex}`
        const recorderApi = window.__arrivalRecorder
        if (!recorderApi) {
          throw new Error('arrival recorder was not installed')
        }
        const samples: (SidebarScrollSample & {
          time: number
          mounted: boolean
          top: number | null
          height: number | null
          scrollTop: number
          pending: boolean
          scrollHeight: number
          clientHeight: number
          maxScrollTop: number
          scrollerGeneration: number
          writesSinceLastSample: number
          lastWriteSeq: number | null
        })[] = []
        let captureTimedOut = false
        let missingSampleCount = 0
        const startedAt = performance.now()
        const recorder = recorderApi.create('data-worktree-sidebar', startedAt)
        const firstScroller = recorder.scroller()
        if (!firstScroller) {
          throw new Error('sidebar scroller was not present when the probe started')
        }
        const initialOffset = firstScroller.scrollTop
        const state = window.__store!.getState()
        state.revealWorktreeInSidebar(targetId, {
          behavior: 'smooth',
          highlight: true,
          beginRename: false
        })
        while (performance.now() - startedAt < 4_000) {
          const observed = await new Promise<boolean>((resolve) => {
            const frame = requestAnimationFrame(() => {
              clearTimeout(timeout)
              resolve(true)
            })
            const timeout = setTimeout(
              () => {
                cancelAnimationFrame(frame)
                resolve(false)
              },
              Math.max(0, 4_500 - (performance.now() - startedAt))
            )
          })
          if (!observed) {
            captureTimedOut = true
            break
          }
          const scroller = recorder.scroller()
          if (!scroller) {
            // No live scroller: record the gap instead of sampling a detached node, and let the
            // absence invalidate the metrics rather than publishing a plausible-looking number.
            recorder.noteMissingSample()
            missingSampleCount++
            continue
          }
          const cursor = recorder.takeWriteCursor()
          const target = scroller.querySelector<HTMLElement>(`[data-worktree-id="${targetId}"]`)
          const viewportTop = scroller.getBoundingClientRect().top + scroller.clientTop
          const rect = target?.getBoundingClientRect()
          const content = target?.querySelector<HTMLElement>(
            '[data-worktree-title-inline-rename]'
          )
          const contentRect = content?.getBoundingClientRect()
          const current = window.__store!.getState()
          samples.push({
            time: performance.now() - startedAt,
            pending:
              current.pendingRevealWorktree !== null || current.pendingRevealSidebarRow !== null,
            highlighted: target?.dataset.scrollRevealHighlight === 'true',
            geometry:
              rect && contentRect && content
                ? {
                    top: rect.top - viewportTop,
                    height: rect.height,
                    viewportHeight: scroller.clientHeight,
                    contentTop: contentRect.top - viewportTop,
                    contentHeight: contentRect.height,
                    contentVisible: content.checkVisibility({
                      checkOpacity: true,
                      checkVisibilityCSS: true
                    })
                  }
                : null,
            mounted: target !== null,
            height: rect?.height ?? null,
            top: rect ? rect.top - viewportTop : null,
            scrollTop: scroller.scrollTop,
            scrollHeight: scroller.scrollHeight,
            clientHeight: scroller.clientHeight,
            maxScrollTop: scroller.scrollHeight - scroller.clientHeight,
            scrollerGeneration: recorder.log().generationCount,
            writesSinceLastSample: cursor.sinceLastSample,
            lastWriteSeq: cursor.lastSeq
          })
        }
        const writeLog: ArrivalWriteLog = recorder.log()
        recorder.stop()
        return {
          samples,
          // A missing-scroller sample invalidates the run's metrics by the analyzer's own rule.
          captureTimedOut: captureTimedOut || missingSampleCount > 0,
          rafCaptureTimedOut: captureTimedOut,
          missingSampleCount,
          initialOffset,
          requestKind: 'worktree',
          targetIndex,
          sidebarHeight: firstScroller.clientHeight,
          writeLog
        }
      },
      { targetIndex }
    )
    const frames = result.samples
    const metrics = measureSidebarScroll(frames, result.initialOffset, result)
    const mountedIntermediate = frames.filter(
      (frame) => frame.mounted && isSidebarScrollIntermediate(frame, metrics)
    ).length
    console.log(
      '[sidebar-arrival-probe]',
      JSON.stringify({
        requestKind: result.requestKind,
        targetIndex,
        idleMs,
        ...metrics,
        mountedIntermediate,
        sidebarHeight: result.sidebarHeight,
        totalWrites: result.writeLog.totalWrites,
        nestedWrites: result.writeLog.nestedWrites,
        smoothWrites: result.writeLog.smoothWrites,
        byKind: result.writeLog.byKind,
        immediateOffsetUnchangedWrites: result.writeLog.immediateOffsetUnchangedWrites,
        threwWrites: result.writeLog.threwWrites,
        truncatedEntries: result.writeLog.truncatedEntries,
        scrollerGenerations: result.writeLog.generationCount,
        missingSampleCount: result.missingSampleCount
      })
    )
    await writeFile(
      testInfo.outputPath('arrival-probe-frames.json'),
      JSON.stringify({ ...result, idleMs, ...metrics, mountedIntermediate }, null, 2)
    )
    expectSidebarScrollProgress(metrics)
    expect(metrics.longestPause, 'no stalled approach').toBeLessThan(200)
    expect(metrics.arrivalMs, 'stable visible landing latency').toBeLessThan(1_700)
    expect(
      metrics.maxReverseStep,
      'no backtracking toward the measured target'
    ).toBeLessThanOrEqual(2)
    expect(metrics.maxOvershoot, 'no overshoot beyond the observed endpoint').toBeLessThanOrEqual(2)
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
    await expect(target.getByText(`Virtual child ${targetIndex}`, { exact: true })).toBeInViewport()
    expect(metrics.highlightedAfterArrival, 'target highlighted at visible landing').toBe(true)
    const landedTop = (await target.boundingBox())!.y
    await orcaPage.waitForTimeout(350)
    await expect(target).toBeInViewport()
    expect(Math.abs((await target.boundingBox())!.y - landedTop)).toBeLessThan(2)
    await orcaPage.screenshot({ path: testInfo.outputPath('arrival-probe-landed.png') })
  })
}
