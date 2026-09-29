// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { ESC, useTerminalMouseWebViewHarness } from './terminal-webview-mouse-test-harness'

function message(data: object) {
  window.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(data) }))
}

function wheel() {
  document.getElementById('terminal-surface')!.dispatchEvent(
    new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      deltaY: 120,
      clientX: 40,
      clientY: 60
    })
  )
}

function swipe() {
  const surface = document.getElementById('terminal-surface')!
  for (const [type, y] of [
    ['touchstart', 240],
    ['touchmove', 120],
    ['touchend', 120]
  ] as const) {
    const event = new Event(type, { bubbles: true, cancelable: true })
    const touch = { identifier: 1, clientX: 40, clientY: y }
    Object.defineProperty(event, 'touches', { value: type === 'touchend' ? [] : [touch] })
    Object.defineProperty(event, 'changedTouches', { value: [touch] })
    surface.dispatchEvent(event)
  }
}

describe('mobile mouse encoding authority', () => {
  const mouse = useTerminalMouseWebViewHarness()

  it('does not guess legacy wheel encoding from tracking alone on an old host', () => {
    mouse.boot()
    mouse.activeTerminal().modes.mouseTrackingMode = 'any'
    message({ type: 'write', data: `${ESC}[?1003h` })
    wheel()
    expect(mouse.terminalInputBytes()).toBe('')
  })

  it.each([
    ['SGR', '?1006h', '[<65;'],
    ['pixel', '?1016h', '[<65;'],
    ['legacy', '?1006l', '[Ma']
  ])('keeps proven %s encoding on old hosts', (_name, mode, prefix) => {
    mouse.boot()
    mouse.activeTerminal().modes.mouseTrackingMode = 'any'
    message({ type: 'write', data: `${ESC}[${mode}${ESC}[?1003h` })
    wheel()
    expect(mouse.terminalInputBytes()).toContain(`${ESC}${prefix}`)
  })

  it('forgets legacy encoding proof on the next snapshot', () => {
    mouse.boot()
    message({ type: 'write', data: `${ESC}[?1006l` })
    message({ type: 'init', cols: 40, rows: 24, initialData: `${ESC}[?1003h` })
    mouse.activeTerminal().modes.mouseTrackingMode = 'any'
    wheel()
    expect(mouse.terminalInputBytes()).toBe('')
  })
  it('does not turn unknown encoding into arrow keys on an alternate screen', () => {
    mouse.boot()
    mouse.activeTerminal().modes.mouseTrackingMode = 'any'
    Object.defineProperty(mouse.activeTerminal().buffer.active, 'type', { value: 'alternate' })
    message({ type: 'write', data: `${ESC}[?1003h` })
    swipe()
    wheel()
    expect(mouse.terminalInputBytes()).toBe('')
  })
})
