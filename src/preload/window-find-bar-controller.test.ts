// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createWindowFindBarUrl } from '../main/window/window-find-bar-html'
import {
  WINDOW_FIND_BAR_ACTIVATE_CHANNEL,
  WINDOW_FIND_BAR_CLOSE_CHANNEL,
  WINDOW_FIND_BAR_QUERY_CHANNEL,
  WINDOW_FIND_BAR_RESULT_CHANNEL,
  WINDOW_FIND_BAR_STEP_CHANNEL
} from '../shared/window-find-bar-contract'
import {
  PRELOAD_WINDOW_FIND_BAR_ACTIVATE_CHANNEL,
  PRELOAD_WINDOW_FIND_BAR_CLOSE_CHANNEL,
  PRELOAD_WINDOW_FIND_BAR_QUERY_CHANNEL,
  PRELOAD_WINDOW_FIND_BAR_RESULT_CHANNEL,
  PRELOAD_WINDOW_FIND_BAR_STEP_CHANNEL,
  installWindowFindBar
} from './window-find-bar-controller'

const LABELS = { label: 'Find in window', previousMatch: 'Prev', nextMatch: 'Next', close: 'Close' }

function required<T>(element: T | null): T {
  if (!element) {
    throw new Error('Find bar markup is missing an element')
  }
  return element
}

function mountBar() {
  const html = decodeURIComponent(
    createWindowFindBarUrl().replace(/^data:text\/html;charset=utf-8,/, '')
  )
  document.documentElement.innerHTML = new DOMParser().parseFromString(
    html,
    'text/html'
  ).documentElement.innerHTML
  const listeners = new Map<string, (event: unknown, payload: unknown) => void>()
  const ipc = {
    send: vi.fn(),
    on: (channel: string, listener: (event: unknown, payload: unknown) => void) => {
      listeners.set(channel, listener)
    }
  }
  installWindowFindBar(document, ipc)
  const input = required(document.querySelector<HTMLInputElement>('#find-input'))
  const count = required(document.querySelector<HTMLElement>('#find-count'))
  const next = required(document.querySelector<HTMLButtonElement>('button[data-step="next"]'))
  const fromMain = (channel: string, payload?: unknown): void =>
    listeners.get(channel)?.({}, payload)
  const type = (text: string): void => {
    input.value = text
    input.dispatchEvent(new Event('input'))
  }
  const press = (key: string, init: KeyboardEventInit = {}): KeyboardEvent => {
    const event = new KeyboardEvent('keydown', { key, cancelable: true, ...init })
    input.dispatchEvent(event)
    return event
  }
  return { ipc, input, count, next, fromMain, type, press }
}

beforeEach(() => {
  document.documentElement.innerHTML = ''
})

describe('window find bar controls', () => {
  it('uses the same channel names as main', () => {
    expect([
      PRELOAD_WINDOW_FIND_BAR_QUERY_CHANNEL,
      PRELOAD_WINDOW_FIND_BAR_STEP_CHANNEL,
      PRELOAD_WINDOW_FIND_BAR_CLOSE_CHANNEL,
      PRELOAD_WINDOW_FIND_BAR_RESULT_CHANNEL,
      PRELOAD_WINDOW_FIND_BAR_ACTIVATE_CHANNEL
    ]).toEqual([
      WINDOW_FIND_BAR_QUERY_CHANNEL,
      WINDOW_FIND_BAR_STEP_CHANNEL,
      WINDOW_FIND_BAR_CLOSE_CHANNEL,
      WINDOW_FIND_BAR_RESULT_CHANNEL,
      WINDOW_FIND_BAR_ACTIVATE_CHANNEL
    ])
  })

  it('searches as you type, steps with Enter and Shift+Enter, and closes on Escape', () => {
    const { ipc, type, press } = mountBar()
    type('needle')
    expect(ipc.send).toHaveBeenLastCalledWith(WINDOW_FIND_BAR_QUERY_CHANNEL, { text: 'needle' })

    expect(press('Enter').defaultPrevented).toBe(true)
    expect(ipc.send).toHaveBeenLastCalledWith(WINDOW_FIND_BAR_STEP_CHANNEL, { forward: true })
    press('Enter', { shiftKey: true })
    expect(ipc.send).toHaveBeenLastCalledWith(WINDOW_FIND_BAR_STEP_CHANNEL, { forward: false })

    ipc.send.mockClear()
    press('Enter', { isComposing: true })
    expect(ipc.send).not.toHaveBeenCalled()

    press('Escape')
    expect(ipc.send).toHaveBeenLastCalledWith(WINDOW_FIND_BAR_CLOSE_CHANNEL)
  })

  it('shows the match count and enables stepping only when something matched', () => {
    const { count, next, fromMain, type } = mountBar()
    type('needle')
    fromMain(WINDOW_FIND_BAR_RESULT_CHANNEL, { activeMatchOrdinal: 2, matches: 5 })
    expect(count.textContent).toBe('2/5')
    expect(next.disabled).toBe(false)

    fromMain(WINDOW_FIND_BAR_RESULT_CHANNEL, { activeMatchOrdinal: 0, matches: 0 })
    expect(count.textContent).toBe('0/0')
    expect(count.dataset.empty).toBe('true')
    expect(next.disabled).toBe(true)

    type('')
    expect(count.textContent).toBe('')
  })

  it('applies labels and re-runs the kept search when reopened', () => {
    const { ipc, input, next, fromMain, type } = mountBar()
    fromMain(WINDOW_FIND_BAR_ACTIVATE_CHANNEL, LABELS)
    expect(input.placeholder).toBe('Find in window')
    expect(next.getAttribute('aria-label')).toBe('Next')
    expect(ipc.send).not.toHaveBeenCalled()

    type('needle')
    ipc.send.mockClear()
    fromMain(WINDOW_FIND_BAR_ACTIVATE_CHANNEL, LABELS)
    expect(ipc.send).toHaveBeenCalledWith(WINDOW_FIND_BAR_QUERY_CHANNEL, { text: 'needle' })
  })
})
