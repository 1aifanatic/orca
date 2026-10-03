// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { Virtualizer } from '@tanstack/react-virtual'
import { describe, expect, it, vi } from 'vitest'
import { createProgrammaticScrollMarks } from './programmatic-scroll-marks'
import {
  useVirtualizedScrollAnchor,
  VIRTUALIZED_SCROLL_ANCHOR_RECORD_EVENT,
  type VirtualizedScrollAnchor
} from './useVirtualizedScrollAnchor'

function setup(useMarks = true, savedAnchor = true) {
  const root = document.createElement('div')
  document.body.append(root)
  Object.defineProperties(root, {
    scrollHeight: { value: 2000 },
    clientHeight: { value: 300 }
  })
  const marks = createProgrammaticScrollMarks()
  const directInput = { current: false }
  const virtualizer = new Virtualizer<HTMLDivElement, HTMLDivElement>({
    count: 10,
    getScrollElement: () => root,
    estimateSize: () => 100,
    initialOffset: savedAnchor ? 200 : 0,
    initialRect: { width: 100, height: 300 },
    scrollToFn: () => {},
    observeElementRect: () => () => {},
    observeElementOffset: () => () => {}
  })
  const anchorRef: { current: VirtualizedScrollAnchor } = {
    current: savedAnchor ? { key: 'row-2', offset: 17, scrollTop: 200 } : null
  }
  const options = {
    anchorRef,
    scrollOffsetRef: { current: savedAnchor ? 200 : 0 },
    rows: Array.from({ length: 10 }, (_, index) => `row-${index}`),
    getRowKey: (key: string) => key,
    getItemElementKey: (element: HTMLDivElement) => element.dataset.key ?? null,
    itemElementSelector: '[data-loaded-row]',
    scrollElementRef: { current: root },
    virtualizer,
    totalSize: virtualizer.getTotalSize(),
    programmaticScrollMarks: useMarks ? marks : undefined,
    hasDirectScrollInput: () => directInput.current,
    restoreSignal: 'initial'
  }
  const hook = renderHook(() => useVirtualizedScrollAnchor(options))
  return { root, anchorRef, directInput, marks, virtualizer, ...hook }
}

function loadedNeighbor(root: HTMLDivElement) {
  vi.spyOn(root, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 100, 300))
  const neighbor = document.createElement('div')
  neighbor.dataset.loadedRow = 'true'
  neighbor.dataset.key = 'row-3'
  vi.spyOn(neighbor, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 80, 100, 100))
  root.append(neighbor)
}

describe('semantic anchor restoration while content is still loading', () => {
  it('hands mount pixel restoration to the source-row restore without losing its offset', () => {
    const { root, anchorRef, unmount } = setup()
    expect(root.scrollTop).toBe(217)
    act(() => root.dispatchEvent(new Event('scroll')))
    expect(root.scrollTop).toBe(217)
    expect(anchorRef.current).toMatchObject({ key: 'row-2', offset: 17 })
    unmount()
    expect(anchorRef.current).toMatchObject({ key: 'row-2', offset: 17 })
    root.remove()
  })

  it('lets an unmarked user scroll replace the pending source-row anchor', () => {
    const { root, anchorRef, unmount } = setup()
    act(() => root.dispatchEvent(new Event('scroll')))
    root.scrollTop = 120
    act(() => root.dispatchEvent(new Event('scroll')))
    expect(root.scrollTop).toBe(120)
    expect(anchorRef.current).toMatchObject({ key: 'row-1', offset: 20 })
    unmount()
    root.remove()
  })

  it('retains an unloaded target through cleanup even when a neighboring row is loaded', () => {
    const { root, anchorRef, unmount } = setup()
    loadedNeighbor(root)
    unmount()
    expect(anchorRef.current).toMatchObject({ key: 'row-2', offset: 17 })
    root.remove()
  })

  it('lets an explicit navigation request replace a pending restoration', () => {
    const { root, anchorRef, marks, unmount } = setup()
    loadedNeighbor(root)
    act(() => root.dispatchEvent(new Event(VIRTUALIZED_SCROLL_ANCHOR_RECORD_EVENT)))
    expect(anchorRef.current).toMatchObject({ key: 'row-3', offset: 0 })
    marks.mark(500)
    root.scrollTop = 500
    act(() => root.dispatchEvent(new Event('scroll')))
    expect(root.scrollTop).toBe(500)
    unmount()
    root.remove()
  })

  it('lets legacy direct input replace a pending anchor before content loads', () => {
    const { root, anchorRef, directInput, unmount } = setup(false)
    directInput.current = true
    root.scrollTop = 120
    act(() => root.dispatchEvent(new Event('scroll')))
    expect(anchorRef.current).toMatchObject({ key: 'row-1', offset: 20 })
    unmount()
    root.remove()
  })

  it('does not restore an earlier position when first navigation creates an anchor', () => {
    const { root, anchorRef, marks, virtualizer, rerender, unmount } = setup(true, false)
    act(() => root.dispatchEvent(new Event(VIRTUALIZED_SCROLL_ANCHOR_RECORD_EVENT)))
    expect(anchorRef.current).toMatchObject({ key: 'row-0', offset: 0 })
    marks.mark(500)
    root.scrollTop = 500
    act(() => root.dispatchEvent(new Event('scroll')))
    virtualizer.isScrolling = true
    rerender()
    expect(root.scrollTop).toBe(500)
    unmount()
    root.remove()
  })

  it('keeps restoration armed when a duplicate scroll event arrives without movement', () => {
    const { root, anchorRef, virtualizer, rerender, unmount } = setup()
    act(() => root.dispatchEvent(new Event('scroll')))
    act(() => root.dispatchEvent(new Event('scroll')))
    vi.spyOn(root, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 100, 300))
    const row = document.createElement('div')
    row.dataset.loadedRow = 'true'
    row.dataset.key = 'row-2'
    vi.spyOn(row, 'getBoundingClientRect').mockImplementation(
      () => new DOMRect(0, 217 - root.scrollTop, 100, 100)
    )
    root.append(row)
    virtualizer.isScrolling = true
    rerender()
    expect(root.scrollTop).toBe(234)
    expect(anchorRef.current).toMatchObject({ key: 'row-2', offset: 17 })
    unmount()
    root.remove()
  })
})
