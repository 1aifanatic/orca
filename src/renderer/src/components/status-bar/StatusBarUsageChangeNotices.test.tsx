// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StatusBarUsageChangeNotices } from './StatusBarUsageChangeNotices'

const state = {
  persistedUIReady: true,
  statusBarCompactChangeNoticeDismissed: false,
  dismissStatusBarCompactChangeNotice: vi.fn(),
  statusBarUsageMode: 'compact',
  statusBarVisible: true,
  activeModal: 'none',
  usagePercentageDisplayChangeNoticeDismissed: true,
  dismissUsagePercentageDisplayChangeNotice: vi.fn()
}

vi.mock('@/store', () => ({
  useAppStore: (selector: (store: typeof state) => unknown) => selector(state)
}))

describe('status bar usage change notices', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      }
    )
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 24,
      y: 700,
      top: 700,
      left: 24,
      bottom: 724,
      right: 200,
      width: 176,
      height: 24,
      toJSON: () => ({})
    })
    Object.assign(state, {
      persistedUIReady: true,
      statusBarCompactChangeNoticeDismissed: false,
      statusBarUsageMode: 'compact',
      statusBarVisible: true,
      activeModal: 'none',
      usagePercentageDisplayChangeNoticeDismissed: true
    })
    state.dismissStatusBarCompactChangeNotice.mockReset()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  function render(hasVisibleUsageMeters = true): void {
    act(() => {
      root.render(
        <StatusBarUsageChangeNotices hasVisibleUsageMeters={hasVisibleUsageMeters}>
          <button>Usage</button>
        </StatusBarUsageChangeNotices>
      )
    })
  }

  function settle(): void {
    act(() => vi.advanceTimersByTime(1_800))
  }

  it('shows an anchored card after the delay without taking keyboard focus', () => {
    render()
    container.querySelector('button')?.focus()
    const focused = document.activeElement
    expect(document.querySelector('[role="status"]')).toBeNull()
    settle()

    const card = document.querySelector('[role="status"]')
    expect(card?.parentElement).toBe(document.body)
    expect(card?.textContent).toContain('Usage is now compact')
    expect(card?.textContent).toContain('Choose Detailed in the Usage menu')
    expect(card?.textContent).toContain('Got it')
    expect(document.activeElement).toBe(focused)
  })

  it.each([
    { persistedUIReady: false },
    { statusBarCompactChangeNoticeDismissed: true },
    { statusBarUsageMode: 'verbose' },
    { statusBarVisible: false },
    { activeModal: 'settings' }
  ])('keeps the card hidden for %o', (updates) => {
    Object.assign(state, updates)
    render()
    settle()
    expect(document.querySelector('[role="status"]')).toBeNull()
  })

  it('waits for usage meters to become visible', () => {
    render(false)
    settle()
    expect(document.querySelector('[role="status"]')).toBeNull()
    render(true)
    settle()
    expect(document.querySelector('[role="status"]')?.textContent).toContain('Usage is now compact')
  })

  it.each(['Got it', 'Dismiss', 'Escape'])('dismisses with %s', (control) => {
    render()
    settle()
    act(() => {
      if (control === 'Escape') {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      } else {
        const button = Array.from(document.querySelectorAll('[role="status"] button')).find(
          (node) => node.textContent === control || node.getAttribute('aria-label') === control
        )
        expect(button).toBeTruthy()
        button?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      }
    })
    expect(state.dismissStatusBarCompactChangeNotice).toHaveBeenCalledTimes(1)
    state.statusBarCompactChangeNoticeDismissed = true
    render()
    settle()
    expect(document.querySelector('[role="status"]')).toBeNull()
  })

  it('does not stack the older percentage callout with the Compact notice', () => {
    state.usagePercentageDisplayChangeNoticeDismissed = false
    render()
    settle()
    expect(document.querySelectorAll('[role="status"]')).toHaveLength(1)
    expect(document.body.textContent).not.toContain('Usage now shows % used')
  })
})
