// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { routeNativeChatRootKeyToInput } from './native-chat-root-key-routing'
import { NativeChatMessageList } from './NativeChatMessageList'
import type { NativeChatMessageListHandle } from './use-native-chat-reveal-latest'
import {
  BELOW_TRANSCRIPT_PX,
  deliverResizes,
  layout,
  list,
  marker,
  ROW_PX,
  scrollTranscript,
  session,
  stubLayout,
  stubResizeObserver,
  TRANSCRIPT_LENGTH
} from './native-chat-windowing-test-harness'

afterEach(cleanup)

function scrollRoot(container: HTMLElement): HTMLElement {
  const scroller = container.querySelector<HTMLElement>('[data-native-chat-scroll]')
  if (!scroller) {
    throw new Error('no transcript scroll root')
  }
  return scroller
}

/** Deliver resize and scroll events to a fixed point, as a painted frame would. */
function paint(container: HTMLElement): void {
  const scroller = scrollRoot(container)
  let lastScrollTop = scroller.scrollTop
  for (let pass = 0; pass < 12; pass += 1) {
    let changed = false
    act(() => {
      changed = deliverResizes()
      vi.advanceTimersByTime(16)
    })
    if (scroller.scrollTop !== lastScrollTop) {
      lastScrollTop = scroller.scrollTop
      fireEvent.scroll(scroller)
      changed = true
    }
    if (!changed && pass >= 2) {
      return
    }
  }
  throw new Error('the transcript never settled: resize and scroll kept moving it')
}

function distanceFromBottom(container: HTMLElement): number {
  const scroller = scrollRoot(container)
  return scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop
}

const transcript = Array.from({ length: TRANSCRIPT_LENGTH }, (_, index) => marker(index))

function userMessage(index: number, text: string): NativeChatMessage {
  return {
    id: `message-${index}`,
    role: 'user',
    blocks: [{ type: 'text', text }],
    timestamp: index + 1,
    source: 'transcript'
  }
}

function toolMessage(index: number): NativeChatMessage {
  return {
    id: `message-${index}`,
    role: 'assistant',
    blocks: [
      { type: 'tool-call', name: 'shell', input: { command: 'pwd' }, state: 'completed' },
      { type: 'tool-result', output: '/repo' }
    ],
    timestamp: index + 1,
    source: 'transcript'
  }
}

function liveList(messages: NativeChatMessage[]): React.JSX.Element {
  return (
    <NativeChatMessageList
      session={session(messages)}
      isWorking
      expandSignal={false}
      fontScale={1}
    />
  )
}

/** The last `count` closed tool runs, with the row each sits in. */
function closedRuns(count: number): { toggle: HTMLElement; rowIndex: number }[] {
  return screen
    .getAllByRole('button', { expanded: false })
    .slice(-count)
    .map((toggle) => {
      const row = toggle.closest<HTMLElement>('[data-index]')
      if (!row) {
        throw new Error('the tool run has no mounted row')
      }
      return { toggle, rowIndex: Number(row.dataset.index) }
    })
}

/** Click a run's toggle and let its row re-measure, as a painted frame would. */
function toggleRun(container: HTMLElement, toggle: HTMLElement, openRows: readonly number[]): void {
  fireEvent.click(toggle)
  const heights = Array.from({ length: Math.max(-1, ...openRows) + 1 }, () => ROW_PX)
  for (const rowIndex of openRows) {
    heights[rowIndex] = ROW_PX * 6
  }
  layout.measuredRowHeights = heights
  paint(container)
}

function offersJumpToLatest(): boolean {
  return screen.queryByRole('button', { name: 'Jump to latest' }) !== null
}

describe('reader navigation', () => {
  let restore: (() => void)[] = []
  beforeEach(() => {
    vi.useFakeTimers()
    restore = [stubLayout({ scrollGeometry: true, offsetChain: true }), stubResizeObserver()]
    layout.belowTranscriptPx = BELOW_TRANSCRIPT_PX
    layout.aboveTranscriptPx = 0
  })
  afterEach(() => {
    for (const undo of restore.toReversed()) {
      undo()
    }
    layout.measuredRowHeights = []
    vi.useRealTimers()
  })

  it('brings a reader who scrolled up to what they just sent, and follows its reply', () => {
    const handle = createRef<NativeChatMessageListHandle>()
    const view = (messages: NativeChatMessage[], isWorking: boolean) => (
      <NativeChatMessageList
        ref={handle}
        session={session(messages)}
        isWorking={isWorking}
        expandSignal={false}
        fontScale={1}
      />
    )
    const { container, rerender } = render(view(transcript, false))
    paint(container)
    scrollTranscript(container, 1000)
    paint(container)
    // Anti-vacuous: the reader is parked well above the end.
    expect(distanceFromBottom(container)).toBeGreaterThan(1000)

    act(() => handle.current?.revealLatest())
    const sent = [...transcript, userMessage(TRANSCRIPT_LENGTH, 'follow-up question')]
    rerender(view(sent, true))
    paint(container)
    rerender(view([...sent, marker(TRANSCRIPT_LENGTH + 1)], true))
    paint(container)

    expect(distanceFromBottom(container)).toBe(0)
    expect(screen.getByText('follow-up question')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Jump to latest' })).toBeNull()
  })

  it('drops a reveal held for a slow send once the reader scrolls away again', () => {
    const handle = createRef<NativeChatMessageListHandle>()
    const { container } = render(
      <NativeChatMessageList
        ref={handle}
        session={session(transcript)}
        isWorking
        expandSignal={false}
        fontScale={1}
      />
    )
    paint(container)
    scrollTranscript(container, 1000)
    paint(container)
    const lapsed = handle.current?.holdRevealLatest()
    scrollTranscript(container, 600)
    paint(container)
    const scrollTop = scrollRoot(container).scrollTop
    act(() => lapsed?.())
    paint(container)
    expect(scrollRoot(container).scrollTop).toBe(scrollTop)

    // Anti-vacuous: one the reader leaves alone still lands on the end.
    const kept = handle.current?.holdRevealLatest()
    act(() => kept?.())
    paint(container)
    expect(distanceFromBottom(container)).toBe(0)
  })

  it('leaves a tool run the reader opens where it is while the turn streams on', () => {
    const toolIndex = TRANSCRIPT_LENGTH
    const withTool: NativeChatMessage[] = [
      ...transcript,
      {
        id: `message-${toolIndex}`,
        role: 'assistant',
        blocks: [
          { type: 'tool-call', name: 'shell', input: { command: 'pwd' }, state: 'completed' },
          { type: 'tool-result', output: '/repo' }
        ],
        timestamp: toolIndex + 1,
        source: 'transcript'
      }
    ]
    const view = (messages: NativeChatMessage[]) => (
      <NativeChatMessageList
        session={session(messages)}
        isWorking
        expandSignal={false}
        fontScale={1}
      />
    )
    const { container, rerender } = render(view(withTool))
    paint(container)
    // Anti-vacuous: following the end, so the run sits at the bottom of the view.
    expect(distanceFromBottom(container)).toBe(0)
    const scrollTopBeforeOpen = scrollRoot(container).scrollTop

    const toggle = screen.getAllByRole('button', { expanded: false }).at(-1)
    const toolRow = toggle?.closest<HTMLElement>('[data-index]')
    if (!toggle || !toolRow) {
      throw new Error('the tool run has no mounted toggle')
    }
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    // The run opens taller, and the turn keeps streaming below it.
    const heights = Array.from({ length: Number(toolRow.dataset.index) + 1 }, () => ROW_PX)
    heights[Number(toolRow.dataset.index)] = ROW_PX * 6
    layout.measuredRowHeights = heights
    paint(container)
    rerender(view([...withTool, marker(toolIndex + 1), marker(toolIndex + 2)]))
    paint(container)

    expect(scrollRoot(container).scrollTop).toBe(scrollTopBeforeOpen)
    expect(distanceFromBottom(container)).toBeGreaterThan(0)
  })

  it('follows the end again once the reader closes what they opened there', () => {
    const toolIndex = TRANSCRIPT_LENGTH
    const withTool: NativeChatMessage[] = [
      ...transcript,
      {
        id: `message-${toolIndex}`,
        role: 'assistant',
        blocks: [
          { type: 'tool-call', name: 'shell', input: { command: 'pwd' }, state: 'completed' },
          { type: 'tool-result', output: '/repo' }
        ],
        timestamp: toolIndex + 1,
        source: 'transcript'
      }
    ]
    const view = (messages: NativeChatMessage[]) => (
      <NativeChatMessageList
        session={session(messages)}
        isWorking
        expandSignal={false}
        fontScale={1}
      />
    )
    const { container, rerender } = render(view(withTool))
    paint(container)
    const toggle = screen.getAllByRole('button', { expanded: false }).at(-1)
    const toolRow = toggle?.closest<HTMLElement>('[data-index]')
    if (!toggle || !toolRow) {
      throw new Error('the tool run has no mounted toggle')
    }
    fireEvent.click(toggle)
    const heights = Array.from({ length: Number(toolRow.dataset.index) + 1 }, () => ROW_PX)
    heights[Number(toolRow.dataset.index)] = ROW_PX * 6
    layout.measuredRowHeights = heights
    paint(container)
    // Anti-vacuous: the open run pushed the end away, and the reader was left where they were.
    expect(distanceFromBottom(container)).toBeGreaterThan(0)

    // Closing lands exactly on the end: no offset moves, so no scroll event reports it.
    fireEvent.click(toggle)
    layout.measuredRowHeights = []
    paint(container)
    expect(distanceFromBottom(container)).toBe(0)
    rerender(view([...withTool, marker(toolIndex + 1), marker(toolIndex + 2)]))
    paint(container)

    expect(distanceFromBottom(container)).toBe(0)
    expect(screen.getByText(`marker-${toolIndex + 2}`)).toBeInTheDocument()
  })

  describe('closing what the reader opened', () => {
    const toolIndex = TRANSCRIPT_LENGTH
    const withTool = [...transcript, toolMessage(toolIndex)]
    const streamedOn = [...withTool, marker(toolIndex + 1), marker(toolIndex + 2)]

    it('closing the last open run preserves history when the tail is still distant', () => {
      const { container, rerender } = render(liveList(withTool))
      paint(container)
      const [run] = closedRuns(1)
      toggleRun(container, run.toggle, [run.rowIndex])
      rerender(liveList(streamedOn))
      paint(container)
      // Anti-vacuous: left behind, well outside the band a scroll would re-arm in.
      expect(distanceFromBottom(container)).toBeGreaterThan(ROW_PX * 5)
      expect(offersJumpToLatest()).toBe(true)

      const beforeClose = scrollRoot(container).scrollTop
      toggleRun(container, run.toggle, [])
      expect(scrollRoot(container).scrollTop).toBe(beforeClose)
      expect(distanceFromBottom(container)).toBeGreaterThan(0)
      expect(offersJumpToLatest()).toBe(true)
      rerender(liveList([...streamedOn, marker(toolIndex + 3)]))
      paint(container)

      expect(scrollRoot(container).scrollTop).toBe(beforeClose)
      expect(distanceFromBottom(container)).toBeGreaterThan(0)
    })

    it('stays where the reader scrolled to while it was open', () => {
      const { container, rerender } = render(liveList(withTool))
      paint(container)
      const [run] = closedRuns(1)
      toggleRun(container, run.toggle, [run.rowIndex])
      const scrolledTo = scrollRoot(container).scrollTop - 100
      scrollTranscript(container, scrolledTo)
      paint(container)

      toggleRun(container, run.toggle, [])
      rerender(liveList(streamedOn))
      paint(container)

      expect(scrollRoot(container).scrollTop).toBe(scrolledTo)
      expect(offersJumpToLatest()).toBe(true)
    })

    it('derives following from geometry rather than counting two open runs', () => {
      const twoTools = [...withTool, marker(toolIndex + 1), toolMessage(toolIndex + 2)]
      const { container, rerender } = render(liveList(twoTools))
      paint(container)
      const [first, second] = closedRuns(2)
      // Anti-vacuous: two different rows.
      expect(first.rowIndex).not.toBe(second.rowIndex)
      toggleRun(container, first.toggle, [first.rowIndex])
      toggleRun(container, second.toggle, [first.rowIndex, second.rowIndex])
      const scrollTopWhileOpen = scrollRoot(container).scrollTop

      toggleRun(container, first.toggle, [second.rowIndex])
      rerender(liveList([...twoTools, marker(toolIndex + 3)]))
      paint(container)
      expect(scrollRoot(container).scrollTop).toBe(scrollTopWhileOpen)
      expect(distanceFromBottom(container)).toBeGreaterThan(0)

      toggleRun(container, second.toggle, [])
      expect(distanceFromBottom(container)).toBeGreaterThan(0)
    })

    it('leaves a reader who had already scrolled away where they are', () => {
      const { container, rerender } = render(liveList(withTool))
      paint(container)
      const scrolledTo = scrollRoot(container).scrollTop - 100
      scrollTranscript(container, scrolledTo)
      paint(container)
      const [run] = closedRuns(1)

      toggleRun(container, run.toggle, [run.rowIndex])
      toggleRun(container, run.toggle, [])
      rerender(liveList(streamedOn))
      paint(container)

      expect(scrollRoot(container).scrollTop).toBe(scrolledTo)
      expect(offersJumpToLatest()).toBe(true)
    })
  })

  it('keeps a run the reader left open in place when its output settles shorter', () => {
    const toolIndex = TRANSCRIPT_LENGTH
    const withTool: NativeChatMessage[] = [
      ...transcript,
      {
        id: `message-${toolIndex}`,
        role: 'assistant',
        blocks: [
          { type: 'tool-call', name: 'shell', input: { command: 'pwd' }, state: 'completed' },
          { type: 'tool-result', output: '/repo' }
        ],
        timestamp: toolIndex + 1,
        source: 'transcript'
      }
    ]
    const view = (messages: NativeChatMessage[]) => (
      <NativeChatMessageList
        session={session(messages)}
        isWorking
        expandSignal={false}
        fontScale={1}
      />
    )
    const { container, rerender } = render(view(withTool))
    paint(container)
    const scrollTopBeforeOpen = scrollRoot(container).scrollTop
    const toggle = screen.getAllByRole('button', { expanded: false }).at(-1)
    const toolRow = toggle?.closest<HTMLElement>('[data-index]')
    if (!toggle || !toolRow) {
      throw new Error('the tool run has no mounted toggle')
    }
    fireEvent.click(toggle)
    const heights = Array.from({ length: Number(toolRow.dataset.index) + 1 }, () => ROW_PX)
    heights[Number(toolRow.dataset.index)] = ROW_PX * 6
    layout.measuredRowHeights = heights
    paint(container)

    // Still open, but now within rounding distance of the end, with no offset moved.
    layout.measuredRowHeights = heights.with(Number(toolRow.dataset.index), ROW_PX + 2)
    paint(container)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(distanceFromBottom(container)).toBe(2)
    rerender(view([...withTool, marker(toolIndex + 1), marker(toolIndex + 2)]))
    paint(container)

    expect(scrollRoot(container).scrollTop).toBe(scrollTopBeforeOpen)
  })

  it('replaces a pending numeric tail pin before a disclosure inserts earlier rows', () => {
    const messages = [
      userMessage(0, 'Earlier turn'),
      ...Array.from({ length: 8 }, (_, i) => toolMessage(i + 1)),
      marker(9),
      userMessage(10, 'Current turn'),
      marker(11)
    ]
    const { container } = render(
      <NativeChatMessageList
        session={session(messages)}
        isWorking
        expandSignal={false}
        fontScale={1}
        settledTurns={new Map([['message-0', { startedAt: 1, workedSeconds: 1 }]])}
      />
    )
    const lastRow = screen.getByText('marker-11').closest<HTMLElement>('[data-index]')
    if (!lastRow) {
      throw new Error('The current answer is not mounted')
    }
    layout.measuredRowHeights = Array.from(
      { length: Number(lastRow.dataset.index) + 1 },
      (_, index) => (index === Number(lastRow.dataset.index) ? ROW_PX * 20 : ROW_PX)
    )
    paint(container)
    const scroller = scrollRoot(container)
    const toggle = screen.getByRole('button', { name: 'Toggle turn details' })
    const window = container.querySelector<HTMLElement>('[data-native-chat-window]')
    const beforeSlots = window?.querySelectorAll('[data-index]').length ?? 0
    toggle.getBoundingClientRect = () => new DOMRect(0, -scroller.scrollTop, 100, 20)
    // A pin created outside the painted frames is still waiting to reconcile by numeric index.
    layout.belowTranscriptPx += 20
    deliverResizes()
    const before = scroller.scrollTop
    expect(before).toBeGreaterThan(0)
    fireEvent.click(toggle)
    const expandedSlots = window?.querySelectorAll('[data-index]').length ?? 0
    expect(expandedSlots).toBeGreaterThan(beforeSlots)
    paint(container)
    expect(scroller.scrollTop).toBe(before)
    expect(distanceFromBottom(container)).toBeGreaterThan(0)
    act(() => vi.advanceTimersByTime(160))
    expect(scroller.scrollTop).toBe(before)
  })

  it.each([false, true])(
    'keeps Space scrolling in the focused transcript (shift=%s)',
    (shiftKey) => {
      const insertTypedText = vi.fn(() => true)
      const focus = vi.fn(() => true)
      const composer = {
        focus,
        insertTypedText,
        handlePasteEvent: vi.fn(),
        pasteFromClipboard: vi.fn(),
        contains: () => false
      }
      const { container } = render(
        <div onKeyDownCapture={(event) => routeNativeChatRootKeyToInput(event, composer, null)}>
          {list(transcript)}
        </div>
      )
      const root = scrollRoot(container)
      root.focus()
      fireEvent.keyDown(root, { key: ' ', shiftKey })
      expect(document.activeElement).toBe(root)
      expect(insertTypedText).not.toHaveBeenCalled()
      expect(focus).not.toHaveBeenCalled()
      fireEvent.keyDown(root, { key: 'a' })
      expect(insertTypedText).toHaveBeenCalledWith('a')
    }
  )

  it('makes the transcript a keyboard stop, so the scroll keys can reach it', () => {
    const { container } = render(list(transcript))

    expect(scrollRoot(container)).toHaveAttribute('tabindex', '0')
  })

  it('names the transcript as a region, so a focused scroll stop is announced', () => {
    const { container } = render(list(transcript))

    expect(screen.getByRole('region', { name: 'Conversation' })).toBe(scrollRoot(container))
  })
})
