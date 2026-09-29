import { describe, expect, it, vi } from 'vitest'
import { createRuntime } from './orca-runtime-test-fixtures.spec'
import { RuntimeTerminalStreamConsumers } from './runtime-terminal-stream-consumers'
import type { TerminalMouseModes } from '../../shared/terminal-mouse-modes'

const sgr = {
  mouseTracking: true,
  mouseTrackingMode: 'any',
  sgrMouseMode: true,
  sgrMousePixelsMode: false
} as const

describe('host mouse mode publication', () => {
  it('captures existing host modes in a late-attach snapshot and sends parsed live changes', async () => {
    const runtime = createRuntime()
    const updates: TerminalMouseModes[] = []
    const unsubscribe = runtime.subscribeToTerminalData(
      'mouse-pty',
      () => {},
      (modes) => updates.push(modes)
    )
    const enable = '\x1b[?1049h\x1b[?1003;1006h'
    runtime.onPtyData('mouse-pty', enable, 1)
    // Queued xterm writes must not publish guessed modes before parsing.
    expect(updates).toEqual([])
    const snapshot = await runtime.serializeMainTerminalBuffer('mouse-pty')
    expect(snapshot?.mouseModes).toEqual({ ...sgr, seq: enable.length })
    expect(updates).toEqual([{ ...sgr, seq: enable.length }])
    runtime.onPtyData('mouse-pty', '\x1b[?100', 2)
    await runtime.serializeMainTerminalBuffer('mouse-pty')
    expect(updates).toHaveLength(1)
    runtime.onPtyData('mouse-pty', '6l', 3)
    const legacy = await runtime.serializeMainTerminalBuffer('mouse-pty')
    expect(legacy?.mouseModes).toEqual({ ...sgr, sgrMouseMode: false, seq: enable.length + 8 })
    expect(updates.at(-1)).toEqual(legacy?.mouseModes)
    unsubscribe()
    runtime.onPtyData('mouse-pty', '\x1bc', 4)
    await runtime.serializeMainTerminalBuffer('mouse-pty')
    expect(updates).toHaveLength(2)
    runtime.resetPtyModelAfterMigrationFailure('mouse-pty')
  })

  it('does not let an old model publish after terminal replacement', async () => {
    const runtime = createRuntime()
    const update = vi.fn()
    const unsub = runtime.subscribeToTerminalData('replaced-mouse-pty', () => {}, update)
    runtime.onPtyData('replaced-mouse-pty', '\x1b[?1003;1006h', 1)
    runtime.resetPtyModelAfterMigrationFailure('replaced-mouse-pty')
    runtime.onPtyData('replaced-mouse-pty', 'new shell', 2)
    await runtime.serializeMainTerminalBuffer('replaced-mouse-pty')
    expect(update).not.toHaveBeenCalled()
    unsub()
    runtime.resetPtyModelAfterMigrationFailure('replaced-mouse-pty')
  })

  it('isolates consumers and removes mode listeners with the output subscription', () => {
    const consumers = new RuntimeTerminalStreamConsumers()
    const listener = vi.fn()
    const unsubscribe = consumers.subscribe('one', vi.fn(), listener)
    consumers.publishMouseModes('two', { ...sgr, seq: 1 })
    expect(listener).not.toHaveBeenCalled()
    consumers.publishMouseModes('one', { ...sgr, seq: 2 })
    expect(listener).toHaveBeenCalledExactlyOnceWith({ ...sgr, seq: 2 })
    unsubscribe()
    consumers.publishMouseModes('one', { ...sgr, seq: 3 })
    expect(listener).toHaveBeenCalledTimes(1)
  })
})
