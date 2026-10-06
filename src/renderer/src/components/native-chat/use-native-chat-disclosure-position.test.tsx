// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { useRef, useState } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useNativeChatTranscriptScroll } from './use-native-chat-transcript-scroll'

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})
function harness() {
  const scrollToEnd = vi.fn()
  const reconcileReaderScroll = vi.fn()
  let itemCount = 10
  let visible = true
  let rectTop = 100
  let height = 1000
  let remove = false
  let heldReveal: (() => void) | undefined
  const restoreScrollOffset = vi.fn((offset: number) => {
    root.scrollTop = offset
  })
  function Harness() {
    const scrollRef = useRef<HTMLDivElement>(null)
    const contentRef = useRef<HTMLDivElement>(null)
    const [, renderAgain] = useState(0)
    const scroll = useNativeChatTranscriptScroll({
      scrollRef,
      contentRef,
      itemCount,
      isWorking: true,
      showsTailRow: true,
      isVisible: visible,
      scrollToEnd,
      restoreScrollOffset,
      reconcileReaderScroll,
      alignToViewportTop: vi.fn(),
      consumeProgrammaticScroll: () => false
    })
    heldReveal = scroll.untilReaderActs(scroll.scrollToBottom)
    return (
      <div
        ref={scrollRef}
        data-testid="root"
        onScroll={scroll.onScroll}
        onClickCapture={scroll.captureDisclosureTarget}
      >
        <div ref={contentRef} />
        {!remove && (
          <button
            onClick={() => {
              scroll.holdDisclosurePosition()
              renderAgain((n) => n + 1)
            }}
          >
            toggle
          </button>
        )}
        <button onClick={scroll.readerLeavesEnd}>navigate</button>
        <output>{String(scroll.showJump)}</output>
      </div>
    )
  }
  const view = render(<Harness />)
  const root = view.getByTestId('root')
  Object.defineProperties(root, {
    clientHeight: { value: 100 },
    offsetHeight: { value: 100 },
    scrollHeight: { get: () => height }
  })
  root.getBoundingClientRect = () => new DOMRect(0, 0, 100, 200)
  root.scrollTop = 900
  const toggle = view.getByText('toggle')
  toggle.getBoundingClientRect = () => new DOMRect(0, rectTop - (root.scrollTop - 900) * 2, 100, 20)
  scrollToEnd.mockClear()
  return {
    ...view,
    root,
    toggle,
    scrollToEnd,
    restoreScrollOffset,
    reconcileReaderScroll,
    held: () => heldReveal,
    grow: () => {
      height += 100
      itemCount += 1
      view.rerender(<Harness />)
    },
    setTop: (n: number) => {
      rectTop = n
    },
    setHeight: (n: number) => {
      height = n
    },
    hide: () => {
      visible = false
      view.rerender(<Harness />)
    },
    remove: () => {
      remove = true
      view.rerender(<Harness />)
    }
  }
}
it('preserves the clicked control through measured drift in a zoomed transcript', () => {
  const h = harness()
  fireEvent.click(h.toggle)
  h.setTop(160)
  h.setHeight(1600)
  act(() => vi.advanceTimersByTime(40))
  expect(h.root.scrollTop).toBe(930)
  expect(h.restoreScrollOffset).toHaveBeenCalledWith(930)
  expect(h.scrollToEnd).not.toHaveBeenCalled()
  expect(h.reconcileReaderScroll).toHaveBeenCalledWith(true)
  expect(h.getByText('true')).toBeTruthy()
})
it('ends a hold when its row disappears and re-derives actual tail proximity', () => {
  const h = harness()
  fireEvent.click(h.toggle)
  h.remove()
  act(() => vi.advanceTimersByTime(40))
  expect(h.scrollToEnd).not.toHaveBeenCalled()
  expect(h.getByText('false')).toBeTruthy()
  // No forgotten row identity prevents following subsequent content.
  h.grow()
  expect(h.scrollToEnd).toHaveBeenCalledOnce()
})
it('reader navigation takes over a pending disclosure position hold', () => {
  const h = harness()
  fireEvent.click(h.toggle)
  fireEvent.click(h.getByText('navigate'))
  h.root.scrollTop = 300
  h.setTop(200)
  fireEvent.scroll(h.root)
  act(() => vi.advanceTimersByTime(300))
  expect(h.root.scrollTop).toBe(300)
  expect(h.restoreScrollOffset).not.toHaveBeenCalled()
  expect(h.scrollToEnd).not.toHaveBeenCalled()
})
it.each(['hide', 'unmount'] as const)('expires a held acceptance after %s', (action) => {
  const h = harness()
  const reveal = h.held()
  h[action]()
  act(() => reveal?.())
  expect(h.scrollToEnd).not.toHaveBeenCalled()
})

it('settles by geometry when layout frames are suspended past the deadline', () => {
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn(() => 999)
  )
  const h = harness()
  fireEvent.click(h.toggle)
  h.remove()
  act(() => vi.advanceTimersByTime(251))
  h.grow()
  expect(h.scrollToEnd).toHaveBeenCalledOnce()
})
