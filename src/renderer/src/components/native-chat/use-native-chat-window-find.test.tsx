// @vitest-environment happy-dom
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { KeybindingOverrides } from '../../../../shared/keybindings'

const mocks = vi.hoisted(() => {
  const bindings: { current?: KeybindingOverrides } = {}
  return { web: false, bindings, openWindowFind: vi.fn() }
})
vi.mock('../../store', () => ({
  useAppStore: { getState: () => ({ keybindings: mocks.bindings.current }) }
}))
vi.mock('@/lib/web-client-location', () => ({
  isWebClientLocation: () => mocks.web
}))
import { nativeChatWindowFindAnchor, useNativeChatWindowFind } from './use-native-chat-window-find'
import { isMacPlatform } from './native-chat-shortcut'

function pressModF(target: EventTarget, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key: 'f',
    code: 'KeyF',
    bubbles: true,
    cancelable: true,
    metaKey: isMacPlatform(),
    ctrlKey: !isMacPlatform(),
    ...init
  })
  target.dispatchEvent(event)
  return event
}

function mountChat(enabled = true): {
  root: HTMLDivElement
  composer: HTMLDivElement
} {
  const root = document.createElement('div')
  const composer = document.createElement('div')
  composer.contentEditable = 'true'
  root.append(composer)
  document.body.append(root)
  root.getBoundingClientRect = () => DOMRect.fromRect({ x: 200, y: 40, width: 500, height: 600 })
  renderHook(() => useNativeChatWindowFind(enabled, { current: root }))
  return { root, composer }
}

beforeEach(() => {
  Object.assign(window, {
    api: { app: { openWindowFind: mocks.openWindowFind } }
  })
})

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
  mocks.web = false
  delete mocks.bindings.current
  mocks.openWindowFind.mockClear()
})

describe('useNativeChatWindowFind', () => {
  it('opens find in window at the chat corner from inside the chat, even from the composer', () => {
    const { composer } = mountChat()
    const event = pressModF(composer)
    expect(event.defaultPrevented).toBe(true)
    expect(mocks.openWindowFind).toHaveBeenCalledWith({
      top: 40,
      rightInset: window.innerWidth - 700
    })
  })

  it('leaves Mod+F alone outside the chat, when not focused, and in the web client', () => {
    mountChat()
    const outside = document.createElement('div')
    document.body.append(outside)
    expect(pressModF(outside).defaultPrevented).toBe(false)

    cleanup()
    const unfocused = mountChat(false)
    expect(pressModF(unfocused.composer).defaultPrevented).toBe(false)

    cleanup()
    mocks.web = true
    const web = mountChat()
    expect(pressModF(web.composer).defaultPrevented).toBe(false)
    expect(mocks.openWindowFind).not.toHaveBeenCalled()
  })

  it('consumes key repeat without reopening, and follows a rebinding', () => {
    const { composer } = mountChat()
    expect(pressModF(composer, { repeat: true }).defaultPrevented).toBe(true)
    expect(mocks.openWindowFind).not.toHaveBeenCalled()

    mocks.bindings.current = { 'chat.find': ['Mod+Shift+F'] }
    expect(pressModF(composer).defaultPrevented).toBe(false)
    expect(pressModF(composer, { shiftKey: true }).defaultPrevented).toBe(true)
    expect(mocks.openWindowFind).toHaveBeenCalledTimes(1)
  })
})

describe('nativeChatWindowFindAnchor', () => {
  it('measures from the window top and right edges, never negative', () => {
    expect(nativeChatWindowFindAnchor({ top: 30, right: 900 }, 1200)).toEqual({
      top: 30,
      rightInset: 300
    })
    expect(nativeChatWindowFindAnchor({ top: -5, right: 1300 }, 1200)).toEqual({
      top: 0,
      rightInset: 0
    })
  })
})
