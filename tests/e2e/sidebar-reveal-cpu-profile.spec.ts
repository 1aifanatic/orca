import { beginRevealCpuProfile } from './reveal-cpu-profile-capture'
import { test, expect } from './sidebar-animation-fixture'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { seedVirtualLineage } from './sidebar-lineage-virtualization-state'
import { worktreeRow } from './worktree-row-locators'

// Diagnostic capture only; existing production timing assertions stay unchanged.
const scenarios = [
  { targetIndex: 100, idleMs: 0, requestKind: 'worktree' },
  { targetIndex: 400, idleMs: 0, requestKind: 'worktree' }
] as const

test.describe.configure({ mode: 'default', retries: 0 })
for (let repeat = 0; repeat < 1; repeat++) {
  for (const scenario of scenarios) {
    test(`control ${repeat} ${scenario.requestKind} child${scenario.targetIndex} idle${scenario.idleMs}`, async ({ orcaPage, electronApp }, testInfo) => {
      await waitForSessionReady(orcaPage)
      await waitForActiveWorktree(orcaPage)
      const runtime = await electronApp.evaluate(({ BrowserWindow }) => ({
        versions: process.versions,
        platform: process.platform,
        architecture: process.arch,
        hidden: BrowserWindow.getAllWindows().every((window) => !window.isVisible() && !window.isFocused())
      }))
      const finishProfile = await beginRevealCpuProfile(orcaPage, testInfo)
      await seedVirtualLineage(orcaPage, false)
      await expect(worktreeRow(orcaPage, 'e2e-virtual-child-0')).toBeVisible()
      await orcaPage.waitForTimeout(scenario.idleMs)
      await orcaPage.emulateMedia({ reducedMotion: 'no-preference' })
      const result = await orcaPage.evaluate(async ({ targetIndex, requestKind }) => {
        const store = window.__store!
        const scroller = document.querySelector<HTMLElement>('[data-worktree-sidebar]')!
        const targetId = `e2e-virtual-child-${targetIndex}`
        const started = performance.now()
        const initialOffset = scroller.scrollTop
        const initialHeight = scroller.clientHeight
        const samples: { time: number; scrollTop: number; top: number | null; height: number | null; documentTop: number | null; viewport: number; pending: number | null; rowPending: boolean; highlighted: boolean; input: boolean; inputVisible: boolean }[] = []
        const requests: { time: number; identity: number | null; rowPending: boolean }[] = []
        const writes: { time: number; api: string; before: number; top: number | null; behavior: string; reason: string }[] = []
        const events: { time: number; kind: string }[] = []
        const longTasks: { time: number; duration: number }[] = []
        const identities = new Map<object, number>()
        const identity = () => {
          const request = store.getState().pendingRevealWorktree
          if (!request) return null
          if (!identities.has(request)) identities.set(request, identities.size + 1)
          return identities.get(request)!
        }
        let previousIdentity: number | null = null
        let previousRowPending = false
        const unsubscribe = store.subscribe(() => {
          const current = identity()
          const rowPending = !!store.getState().pendingRevealSidebarRow
          if (current !== previousIdentity || rowPending !== previousRowPending) {
            requests.push({ time: performance.now() - started, identity: current, rowPending })
            previousIdentity = current
            previousRowPending = rowPending
          }
        })
        const originalScrollTo = scroller.scrollTo
        const ownScrollTo = Object.getOwnPropertyDescriptor(scroller, 'scrollTo')
        scroller.scrollTo = (options?: ScrollToOptions | number, y?: number) => {
          writes.push({ time: performance.now() - started, api: 'scrollTo', before: scroller.scrollTop,
            top: typeof options === 'number' ? y ?? 0 : options?.top ?? null,
            behavior: typeof options === 'number' ? 'positional' : options?.behavior ?? 'default', reason: 'unknown' })
          if (typeof options === 'number') originalScrollTo.call(scroller, options, y ?? 0)
          else originalScrollTo.call(scroller, options)
        }
        const ownScrollTop = Object.getOwnPropertyDescriptor(scroller, 'scrollTop')
        const nativeScrollTop = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop')
        const setterIntercepted = !!nativeScrollTop?.get && !!nativeScrollTop?.set
        if (setterIntercepted) Object.defineProperty(scroller, 'scrollTop', {
          configurable: true,
          get() { return nativeScrollTop!.get!.call(this) },
          set(value: number) {
            writes.push({ time: performance.now() - started, api: 'scrollTop', before: nativeScrollTop!.get!.call(this), top: value, behavior: 'setter', reason: 'unknown' })
            nativeScrollTop!.set!.call(this, value)
          }
        })
        const onAnchor = () => events.push({ time: performance.now() - started, kind: 'anchor-record' })
        const onScrollEnd = () => events.push({ time: performance.now() - started, kind: 'scrollend' })
        scroller.addEventListener('orca-record-virtualized-scroll-anchor', onAnchor)
        scroller.addEventListener('scrollend', onScrollEnd)
        const observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) longTasks.push({ time: entry.startTime - started, duration: entry.duration })
        })
        const longTaskSupported = PerformanceObserver.supportedEntryTypes.includes('longtask')
        if (longTaskSupported) observer.observe({ type: 'longtask' })
        let raf = 0
        const sample = () => {
          const target = scroller.querySelector<HTMLElement>(`[data-worktree-id="${targetId}"]`)
          const rect = target?.getBoundingClientRect()
          const container = scroller.getBoundingClientRect()
          const input = target?.querySelector('input')?.getBoundingClientRect()
          const top = rect ? rect.top - container.top : null
          samples.push({ time: performance.now() - started, scrollTop: scroller.scrollTop,
            top, height: rect?.height ?? null, documentTop: top === null ? null : top + scroller.scrollTop,
            viewport: scroller.clientHeight, pending: identity(), rowPending: !!store.getState().pendingRevealSidebarRow,
            highlighted: target?.getAttribute('data-scroll-reveal-highlight') === 'true', input: !!input,
            inputVisible: !!input && input.top >= container.top && input.bottom <= container.top + scroller.clientHeight })
        }
        const requestAtMs = performance.now() - started
        try {
          store.getState().revealWorktreeInSidebar(targetId, { behavior: 'smooth', highlight: true, beginRename: requestKind === 'rename' })
          await new Promise<void>((resolve) => {
            // A timer ends capture even when RAF is suppressed; the outer test timeout bounds renderer hangs.
            const timer = setTimeout(() => { cancelAnimationFrame(raf); sample(); resolve() }, 4500)
            const tick = () => { sample(); raf = requestAnimationFrame(tick) }
            raf = requestAnimationFrame(tick)
            void timer
          })
        } finally {
          cancelAnimationFrame(raf)
          unsubscribe()
          observer.disconnect()
          scroller.removeEventListener('orca-record-virtualized-scroll-anchor', onAnchor)
          scroller.removeEventListener('scrollend', onScrollEnd)
          if (ownScrollTo) Object.defineProperty(scroller, 'scrollTo', ownScrollTo)
          else Reflect.deleteProperty(scroller, 'scrollTo')
          if (setterIntercepted) {
            if (ownScrollTop) Object.defineProperty(scroller, 'scrollTop', ownScrollTop)
            else Reflect.deleteProperty(scroller, 'scrollTop')
          }
        }
        return { startedAt: started, timeOrigin: performance.timeOrigin, initialOffset, initialHeight, requestAtMs, samples, requests, writes, events, longTasks, longTaskSupported, setterIntercepted,
          viewport: { width: innerWidth, height: innerHeight }, visibility: document.visibilityState }
      }, scenario).finally(finishProfile)
      const frames = result.samples
      const last = frames.at(-1)!
      const suffix = frames.filter((frame) => frame.time >= last.time - 650)
      const range = (values: number[]) => Math.max(...values) - Math.min(...values)
      const suffixGaps = suffix.slice(1).map((frame, index) => frame.time - suffix[index].time)
      const settled = suffix.length >= 8 && last.time - suffix[0].time >= 500 && Math.max(...suffixGaps) <= 100 &&
        suffix.every((frame) => frame.top !== null && frame.height !== null && frame.top >= 0 && frame.top + frame.height <= frame.viewport && frame.pending === null && !frame.rowPending && (scenario.requestKind !== 'rename' || frame.inputVisible)) &&
        range(suffix.map((frame) => frame.scrollTop)) <= 1 &&
        range(suffix.map((frame) => frame.documentTop ?? NaN)) <= 1 &&
        range(suffix.map((frame) => frame.height ?? NaN)) <= 1 &&
        range(suffix.map((frame) => frame.viewport)) === 0
      const finalOffset = settled ? last.scrollTop : null
      const firstMotion = frames.find((frame) => Math.abs(frame.scrollTop - result.initialOffset) > 1)
      let lastOffset = result.initialOffset
      let previousMovement = firstMotion?.time ?? 0
      let laterPauseMs = 0
      for (const frame of frames) {
        if (Math.abs(frame.scrollTop - lastOffset) > 0) {
          if (firstMotion && frame.time > firstMotion.time) laterPauseMs = Math.max(laterPauseMs, frame.time - previousMovement)
          previousMovement = frame.time
          lastOffset = frame.scrollTop
        }
      }
      const direction = finalOffset === null ? 0 : Math.sign(finalOffset - result.initialOffset)
      const lastAway = finalOffset === null ? -1 : frames.findLastIndex((frame) => Math.abs(frame.scrollTop - finalOffset) > 2)
      const lastGeometryAway = settled ? frames.findLastIndex((frame) =>
        frame.top === null || frame.height === null || frame.documentTop === null ||
        Math.abs(frame.scrollTop - last.scrollTop) > 1 ||
        Math.abs(frame.documentTop - last.documentTop!) > 1 || Math.abs(frame.height - last.height!) > 1 ||
        frame.top < 0 || frame.top + frame.height > frame.viewport ||
        (scenario.requestKind === 'rename' && !frame.inputVisible)) : -1
      const firstVisible = frames.findIndex((frame) => frame.top !== null && frame.top >= 0 && frame.top < frame.viewport)
      const metrics = {
        settled, censored: !settled, horizonMs: last.time - result.requestAtMs,
        firstRafMs: frames[0].time - result.requestAtMs,
        firstMotionMs: firstMotion ? firstMotion.time - result.requestAtMs : null,
        laterPauseMs, finalOffset,
        geometryArrivalMs: settled && frames[lastGeometryAway + 1] ? frames[lastGeometryAway + 1].time - result.requestAtMs : null,
        firstTitleTopVisibleMs: firstVisible >= 0 ? frames[firstVisible].time - result.requestAtMs : null,
        titleTopRetained: firstVisible >= 0 && frames.slice(firstVisible).every((frame) => frame.top !== null && frame.top >= 0 && frame.top < frame.viewport),
        arrivalMs: settled && frames[lastAway + 1] ? frames[lastAway + 1].time - result.requestAtMs : null,
        stableSuffixStartMs: settled ? suffix[0].time - result.requestAtMs : null,
        maxFrameGapMs: Math.max(...frames.map((frame, index) => frame.time - (frames[index - 1]?.time ?? result.requestAtMs))),
        direction,
        maxReverseStep: direction ? Math.max(0, ...frames.map((frame, index) => -direction * (frame.scrollTop - (frames[index - 1]?.scrollTop ?? result.initialOffset)))) : null,
        overshoot: direction && finalOffset !== null ? Math.max(0, ...frames.map((frame) => direction * (frame.scrollTop - finalOffset))) : null,
        distinctPositions: new Set(frames.map((frame) => frame.scrollTop)).size,
        firstInputVisibleMs: frames.some((frame) => frame.inputVisible) ? frames.find((frame) => frame.inputVisible)!.time - result.requestAtMs : null,
        firstHighlightMs: frames.some((frame) => frame.highlighted) ? frames.find((frame) => frame.highlighted)!.time - result.requestAtMs : null
      }
      const evidence = { scenario, repeat, runtime, ...result, metrics }
      await testInfo.attach('sidebar-control.json', { body: JSON.stringify(evidence), contentType: 'application/json' })
      // Successful workflow runs upload no test artifacts, so keep numeric evidence in the job log too.
      console.log('[sidebar-control]', JSON.stringify(evidence))
      expect(runtime.hidden).toBe(true)
      expect(frames.length).toBeGreaterThan(8)
      expect(metrics.horizonMs).toBeGreaterThanOrEqual(4400)
    })
  }
}
