// @vitest-environment happy-dom
import React, { act, useLayoutEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useWorktreeListVirtualizer, type WorktreeListVirtualizer } from './use-virtualizer'
import {
  useWorktreeSidebarScrollSuppression,
  type WorktreeSidebarScrollSuppression
} from './use-scroll-suppression'
import type { VirtualizedScrollAnchor } from '@/hooks/useVirtualizedScrollAnchor'
import { lineageRow } from '../rows/lineage-virtualization-test-fixtures'
import type { RenderRow } from '../listing/render-row'
import { revealElementInScrollContainer } from '../../worktree-sidebar-reveal'
import { completeMountedSidebarReveal } from '../navigation/complete-mounted-reveal'

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: { renamingWorktreeId: null }) => unknown) =>
    selector({ renamingWorktreeId: null })
}))
globalThis.IS_REACT_ACT_ENVIRONMENT = true
let element: HTMLDivElement
let root: Root
let current: WorktreeListVirtualizer
let suppression: WorktreeSidebarScrollSuppression
let height: number
let width: number
let rowHeight: number
let viewportHeight: number
let pendingReveal: { worktreeId: string; behavior: 'auto' } | null
let committedAnchors: VirtualizedScrollAnchor[]
let activeId: string | null
let reads: number
let writes: { top: number; extent: number }[]
let observers: { callback: ResizeObserverCallback; targets: Set<Element> }[]
let originalRect: typeof Element.prototype.getBoundingClientRect
const anchorRef: React.MutableRefObject<VirtualizedScrollAnchor> = { current: null }
const offsetRef = { current: 200 }
let scrollRef: React.RefObject<HTMLDivElement | null>
const rows: RenderRow[] = [
  lineageRow('a', 0),
  lineageRow('b', 0),
  lineageRow('c', 0),
  lineageRow('d', 0)
]
function Probe({
  tick = 0,
  renderRows = rows,
  newCardStyle = false
}: {
  tick?: number
  renderRows?: RenderRow[]
  newCardStyle?: boolean
}) {
  const policy = useWorktreeSidebarScrollSuppression(scrollRef)
  const owner = useWorktreeListVirtualizer({
    renderRows,
    firstHeaderIndex: -1,
    scrollRef,
    scrollOffsetRef: offsetRef,
    scrollAnchorRef: anchorRef,
    suppression: policy,
    newCardStyle,
    draggingWorktreeId: null,
    props: {
      activeWorktreeId: activeId,
      activeWorkspaceExecutionHostId: 'local',
      pendingRevealWorktree: pendingReveal,
      pendingRevealSidebarRow: null,
      defaultHostId: 'local'
    }
  })
  useLayoutEffect(() => {
    committedAnchors.push(anchorRef.current)
    current = owner
    suppression = policy
  })
  if (renderRows[0]?.type === 'lineage-group') {
    return (
      <div data-sizer="" style={{ height: owner.total }}>
        <div data-owner-tree="" data-index="0" ref={owner.measureVirtualRowElement}>
          <div
            data-lineage-virtual-children=""
            data-owner-tree-children=""
            style={{ height: owner.total - owner.boundaries[1]! }}
          >
            {[...owner.selected]
              .filter((index) => index > 0)
              .map((index) => {
                const node = owner.model.nodes[index]!
                return (
                  <div
                    key={node.key}
                    data-owner-tree-leaf=""
                    data-owner-start={owner.boundaries[node.slot]}
                    data-sidebar-geometry-node={node.key}
                    data-worktree-id={node.row.type === 'item' ? node.row.worktree.id : undefined}
                  />
                )
              })}
          </div>
        </div>
      </div>
    )
  }
  return (
    <div data-sizer="" data-tick={tick} style={{ height: owner.total }}>
      {owner.outerItems.map((item) => (
        <div key={item.key} data-index={item.index} ref={owner.measureVirtualRowElement} />
      ))}
    </div>
  )
}
beforeEach(() => {
  height = 116
  committedAnchors = []
  activeId = null
  width = 300
  rowHeight = 116
  viewportHeight = 100
  pendingReveal = null
  reads = 0
  writes = []
  observers = []
  anchorRef.current = null
  offsetRef.current = 200
  element = document.createElement('div')
  element.style.paddingTop = '1px'
  document.body.append(element)
  element.scrollTop = 200
  scrollRef = { current: element }
  Object.defineProperties(element, {
    clientWidth: { get: () => width },
    clientHeight: { get: () => viewportHeight },
    offsetWidth: { get: () => 300 },
    offsetHeight: { get: () => viewportHeight },
    scrollHeight: {
      get: () =>
        Math.round(
          Number.parseFloat(
            element.querySelector<HTMLElement>('[data-sizer]')?.style.height ?? '0'
          ) + 1
        )
    }
  })
  element.scrollTo = (options) => {
    const top = typeof options === 'object' ? (options.top ?? 0) : (options ?? 0)
    writes.push({ top, extent: element.scrollHeight })
    element.scrollTop = top
  }
  originalRect = Element.prototype.getBoundingClientRect
  Element.prototype.getBoundingClientRect = function () {
    if (this === element) {
      return new DOMRect(0, 0, 300, viewportHeight)
    }
    if (this.hasAttribute('data-owner-tree')) {
      const children = this.querySelector<HTMLElement>('[data-owner-tree-children]')!
      return new DOMRect(
        0,
        -element.scrollTop,
        300,
        height + Number.parseFloat(children.style.height)
      )
    }
    if (this instanceof HTMLElement && this.hasAttribute('data-owner-tree-children')) {
      return new DOMRect(0, height - element.scrollTop, 300, Number.parseFloat(this.style.height))
    }
    if (this.hasAttribute('data-owner-tree-leaf')) {
      return new DOMRect(
        0,
        Number(this.getAttribute('data-owner-start')) + 1 - element.scrollTop,
        300,
        rowHeight
      )
    }
    const index = this.getAttribute('data-index')
    if (index !== null) {
      reads++
      return new DOMRect(0, 0, 300, index === '0' ? height : rowHeight)
    }
    return new DOMRect()
  }
  vi.stubGlobal(
    'ResizeObserver',
    class implements ResizeObserver {
      record: { callback: ResizeObserverCallback; targets: Set<Element> }
      constructor(callback: ResizeObserverCallback) {
        this.record = { callback, targets: new Set() }
        observers.push(this.record)
      }
      observe(target: Element) {
        this.record.targets.add(target)
      }
      unobserve(target: Element) {
        this.record.targets.delete(target)
      }
      disconnect() {
        this.record.targets.clear()
      }
    }
  )
  root = createRoot(element)
})
afterEach(async () => {
  await act(async () => root.unmount())
  element.remove()
  Element.prototype.getBoundingClientRect = originalRect
  vi.unstubAllGlobals()
})
async function render(tick = 0) {
  await act(async () => root.render(<Probe tick={tick} />))
  writes.length = 0
}
async function nativeDelivery() {
  const observer = observers.find((candidate) =>
    [...candidate.targets].some((node) => node.hasAttribute('data-sidebar-geometry-node'))
  )
  expect(observer).toBeDefined()
  await act(async () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The callback only triggers sampling; it does not inspect the observer argument.
    observer!.callback([], {} as ResizeObserver)
  })
}
describe('single sidebar geometry owner', () => {
  it('writes once only after changed native observations have matching committed sizer geometry', async () => {
    await render()
    const before = element.scrollTop
    height += 37
    await nativeDelivery()
    expect(writes).toEqual([{ top: before + 37, extent: 520 }])
    expect(element.scrollTop).toBe(before + 37)
    const previousReads = reads
    await nativeDelivery()
    expect(reads).toBeGreaterThan(previousReads)
    expect(writes).toHaveLength(1)
  })
  it('fences layout publication from the old committed sizer', async () => {
    await render()
    height += 37
    await act(async () => root.render(<Probe tick={1} />))
    expect(writes).toHaveLength(1)
    expect(writes[0]!.extent).toBe(520)
  })
  it('preserves real input cancellation and observed fold eligibility', async () => {
    await render()
    suppression.markDirectScrollInput()
    height += 37
    await nativeDelivery()
    expect(writes).toHaveLength(0)
    expect(current.total).toBe(519)
  })
  it('disconnects observations on unmount and never retains disconnected element measurements', async () => {
    await render()
    await act(async () => root.render(null))
    expect(observers.every((observer) => observer.targets.size === 0)).toBe(true)
  })
  it('prepares and commits a nonzero navigation destination despite the initiating input suppression', async () => {
    await render()
    await act(async () => {
      suppression.markDirectScrollInput()
      current.navigationVirtualizer.scrollToIndex(3, { align: 'end' })
    })
    expect(writes.at(-1)).toEqual({ top: 383, extent: 483 })
  })
  it('resolves a surviving structural anchor on the new nonzero boundary', async () => {
    await render()
    anchorRef.current = { key: 'wt:all:|c', offset: 10, scrollTop: 200 }
    await act(async () => root.render(<Probe renderRows={rows.slice(1)} />))
    expect(writes.at(-1)).toEqual({ top: 133, extent: 361 })
  })
  it('restores semantic identity after hidden width/style invalidation using the same anchor owner', async () => {
    await render()
    height = 153
    await nativeDelivery()
    element.scrollTop = 292
    await act(async () => root.render(null))
    expect(anchorRef.current?.key).toBe('wt:all:|c')
    expect(anchorRef.current?.offset).toBe(10)
    width = 280
    height = 116
    writes.length = 0
    await act(async () => root.render(<Probe newCardStyle />))
    expect(writes.at(-1)).toEqual({ top: 255, extent: 483 })
    expect(element.scrollTop).toBe(255)
  })
  it('does not write after direct input supersedes queued navigation before its commit', async () => {
    await render()
    await act(async () => {
      current.navigationVirtualizer.scrollToIndex(3, { align: 'end' })
      suppression.markDirectScrollInput()
    })
    expect(writes).toHaveLength(0)
    expect(current.presentationOffset).toBe(element.scrollTop)
  })
})

it('captures the committed viewport after one large scroll with a distant active row retained', async () => {
  const manyRows = Array.from({ length: 500 }, (_, index) => lineageRow(`row-${index}`, 0))
  activeId = 'row-490'
  await act(async () => root.render(<Probe renderRows={manyRows} />))
  writes.length = 0
  await act(async () => {
    element.scrollTop = 24401
    element.dispatchEvent(new Event('scroll'))
    suppression.markScrollMovement()
  })
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 550))
  })
  expect(anchorRef.current?.key).toBe('wt:all:|row-200')
  writes.length = 0
  await act(async () => root.render(<Probe renderRows={manyRows.slice(1)} />))
  expect(element.scrollTop).toBe(24279)
  expect(writes).toEqual([{ top: 24279, extent: element.scrollHeight }])
})

it('keeps the original anchor throughout pending structural restoration commits', async () => {
  await render()
  await act(async () => {
    element.scrollTop = 255
    element.dispatchEvent(new Event('scroll'))
  })
  expect(anchorRef.current?.key).toBe('wt:all:|c')
  committedAnchors = []
  await act(async () => {
    element.dispatchEvent(new Event('scroll'))
    root.render(<Probe renderRows={rows.slice(1)} />)
  })
  expect(writes).toEqual([{ top: 133, extent: 361 }])
  expect(committedAnchors.length).toBeGreaterThan(1)
  expect(
    committedAnchors.every((anchor) => anchor?.key === 'wt:all:|c' && anchor.offset === 10)
  ).toBe(true)
})

it('compensates fully above-fold growth when only the following gap spans the fold', async () => {
  await render()
  expect(current.retainedItems[0]).toMatchObject({ start: 1, end: 117, size: 116 })
  expect(current.outerItems[0]).toMatchObject({ start: 0, end: 116, size: 116 })
  await act(async () => {
    element.scrollTop = 120
    element.dispatchEvent(new Event('scroll'))
    suppression.markScrollMovement()
  })
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 550))
  })
  expect(anchorRef.current?.key).toBe('wt:all:|b')
  writes.length = 0
  height += 37
  await nativeDelivery()
  expect(element.scrollTop).toBe(157)
  expect(writes).toEqual([{ top: 157, extent: 520 }])
})

it('premeasures an end-aligned recycled lineage before the mounted auto reveal completes', async () => {
  const tree: RenderRow[] = [
    {
      type: 'lineage-group',
      key: 'root',
      rows: [
        lineageRow('root', 0),
        ...Array.from({ length: 500 }, (_, index) => lineageRow(`row-${index}`, 1))
      ]
    }
  ]
  viewportHeight = 519
  element.scrollTop = offsetRef.current = 1
  activeId = 'root'
  await act(async () => root.render(<Probe renderRows={tree} />))
  rowHeight = height = 38
  await act(async () => root.render(<Probe renderRows={tree} newCardStyle />))
  pendingReveal = { worktreeId: 'row-400', behavior: 'auto' }
  await act(async () => root.render(<Probe renderRows={tree} newCardStyle />))
  const target = element.querySelector<HTMLElement>('[data-worktree-id="row-400"]')!
  writes.length = 0
  await act(async () => {
    revealElementInScrollContainer(element, target, 'auto', suppression.markRevealScroll)
    completeMountedSidebarReveal({
      container: element,
      element: target,
      behavior: 'auto',
      cancelled: () => false,
      isScrollSettling: suppression.isRevealScrollSettling,
      wasScrollInterrupted: suppression.wasRevealScrollInterrupted,
      markRevealScroll: suppression.markRevealScroll,
      scheduleFrame: () => {
        throw new Error('Auto arrival must not need a timer')
      },
      complete: (landed) => {
        expect(landed).toBe(true)
        pendingReveal = null
        root.render(<Probe renderRows={tree} newCardStyle />)
      }
    })
    element.dispatchEvent(new Event('scroll'))
    suppression.markScrollMovement()
  })
  const landed = target.getBoundingClientRect()
  expect(landed.top).toBeGreaterThanOrEqual(0)
  expect(landed.bottom).toBeLessThanOrEqual(viewportHeight)
  expect(writes).toHaveLength(1)
  expect(current.selected.size).toBeLessThan(60)
})
