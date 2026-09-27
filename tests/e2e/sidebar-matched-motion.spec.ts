import { writeFile } from 'node:fs/promises'
import { measureSidebarScroll } from './sidebar-scroll-timeline'
import { test, expect } from './sidebar-animation-fixture'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { seedVirtualLineage } from './sidebar-lineage-virtualization-state'
import { worktreeRow } from './worktree-row-locators'

// Diagnostic capture only; existing production timing assertions stay unchanged.
const scenarios = [
  { targetIndex: 100, idleMs: 0, requestKind: 'worktree' },
  { targetIndex: 400, idleMs: 0, requestKind: 'worktree' },
  { targetIndex: 400, idleMs: 800, requestKind: 'worktree' },
  { targetIndex: 400, idleMs: 0, requestKind: 'rename' },
  { targetIndex: 400, idleMs: 800, requestKind: 'rename' }
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
        const samples: { time: number; scrollTop: number; top: number | null; height: number | null; documentTop: number | null; viewport: number; pending: number | null; rowPending: boolean; highlighted: boolean; input: boolean; inputVisible: boolean; contentTop: number | null; contentHeight: number | null; contentVisible: boolean }[] = []
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
          const content = (requestKind === 'rename' ? target?.querySelector('input') : target?.querySelector('[data-worktree-title-inline-rename]'))?.getBoundingClientRect()
          const top = rect ? rect.top - container.top : null
          samples.push({ time: performance.now() - started, scrollTop: scroller.scrollTop,
            top, height: rect?.height ?? null, documentTop: top === null ? null : top + scroller.scrollTop,
            viewport: scroller.clientHeight, pending: identity(), rowPending: !!store.getState().pendingRevealSidebarRow,
            highlighted: target?.getAttribute('data-scroll-reveal-highlight') === 'true', input: !!input,
            inputVisible: !!input && input.top >= container.top && input.bottom <= container.top + scroller.clientHeight,
            contentTop: content ? content.top - container.top : null, contentHeight: content?.height ?? null, contentVisible: !!content && content.width > 0 && content.height > 0 })
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
        return { initialOffset, initialHeight, requestAtMs, samples, requests, writes, events, longTasks, longTaskSupported, setterIntercepted,
          viewport: { width: innerWidth, height: innerHeight }, visibility: document.visibilityState }
      }, scenario)
      const frames = result.samples
      const metrics = measureSidebarScroll(frames.map((frame) => ({
        time: frame.time - result.requestAtMs,
        scrollTop: frame.scrollTop,
        highlighted: frame.highlighted,
        geometry: frame.top === null || frame.height === null || frame.contentTop === null || frame.contentHeight === null ? null : {
          top: frame.top, height: frame.height, viewportHeight: frame.viewport,
          contentTop: frame.contentTop, contentHeight: frame.contentHeight, contentVisible: frame.contentVisible
        }
      })), result.initialOffset)
      const firstTitle = frames.find((frame) => frame.contentTop !== null && frame.contentTop >= 34 && frame.contentTop + (frame.contentHeight ?? 0) <= frame.viewport)
      const extra = {
        firstReadableContentMs: firstTitle ? firstTitle.time - result.requestAtMs : null,
        firstInputVisibleMs: frames.some((frame) => frame.inputVisible) ? frames.find((frame) => frame.inputVisible)!.time - result.requestAtMs : null,
        finalPending: frames.at(-1)?.pending,
        smoothWriteCount: result.writes.filter((write) => write.behavior === 'smooth').length,
        historicalArrival1700Exceeded: metrics.arrivalMs === null ? null : metrics.arrivalMs >= 1700,
        arm: process.env.ORCA_REVEAL_ARM ?? 'unspecified', leg: process.env.ORCA_REVEAL_LEG ?? 'unspecified'
      }
      const evidence = { scenario, repeat, runtime, ...result, metrics, extra }
      const path = testInfo.outputPath('sidebar-control.json')
      await writeFile(path, JSON.stringify(evidence))
      await testInfo.attach('sidebar-control.json', { path, contentType: 'application/json' })
      // Successful workflow runs upload no test artifacts, so keep numeric evidence in the job log too.
      console.log('[sidebar-control]', JSON.stringify(evidence))
      expect(runtime.hidden).toBe(true)
      expect(frames.length).toBeGreaterThan(8)
      expect(frames.at(-1)!.time - result.requestAtMs).toBeGreaterThanOrEqual(4400)
      expect(metrics.status).toBe('complete')
    })
  }
}
