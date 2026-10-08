// @vitest-environment happy-dom
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useNativeChatReplyReveals } from './native-chat-reply-reveals'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function windowAt(start: number): string[] {
  return Array.from({ length: 300 }, (_, index) => `row-${start + index}`)
}

describe('transcript reply reveal retention', () => {
  it('shows initial history immediately and begins only a newly arriving tail reply', () => {
    const view = renderHook(({ rows }) => useNativeChatReplyReveals(rows, new Set(rows)), {
      initialProps: { rows: ['user', 'existing'] }
    })
    expect(view.result.current.begun.size).toBe(0)
    view.rerender({ rows: ['older', 'user', 'existing'] })
    expect(view.result.current.begun.size).toBe(0)
    view.rerender({ rows: ['older', 'user', 'existing', 'reply'] })
    expect([...view.result.current.begun]).toEqual(['reply'])
  })

  it('does not replay a loaded reply after its section closes and reopens', () => {
    const loaded = new Set(['user', 'child-reply'])
    const view = renderHook(({ rows }) => useNativeChatReplyReveals(rows, loaded), {
      initialProps: { rows: ['user'] }
    })
    view.rerender({ rows: ['user', 'child-reply'] })
    expect(view.result.current.begun.has('child-reply')).toBe(true)
    view.result.current.drawn.set('child-reply', {
      source: 'received',
      shown: 3,
      arrivals: [{ from: 3, to: 8, at: 0 }]
    })
    view.rerender({ rows: ['user'] })
    expect(view.result.current.begun.size).toBe(0)
    expect(view.result.current.drawn.size).toBe(0)
    view.rerender({ rows: ['user', 'child-reply'] })
    expect(view.result.current.begun.size).toBe(0)
  })

  it('retires hidden replies when the loaded inventory changes without changing visible rows', () => {
    const rows = ['user']
    const view = renderHook(({ visible, loaded }) => useNativeChatReplyReveals(visible, loaded), {
      initialProps: { visible: rows, loaded: new Set(['user', 'child-reply']) }
    })
    view.rerender({ visible: ['user', 'child-reply'], loaded: new Set(['user', 'child-reply']) })
    view.rerender({ visible: rows, loaded: new Set(['user', 'child-reply']) })
    view.rerender({ visible: rows, loaded: new Set(['user']) })
    view.rerender({ visible: ['user', 'child-reply'], loaded: new Set(['user', 'child-reply']) })
    expect([...view.result.current.begun]).toEqual(['child-reply'])
  })

  it('remembers a folded reply as the rest of the loaded history window advances', () => {
    const view = renderHook(
      ({ rows }) => useNativeChatReplyReveals(rows, new Set(['child-reply', ...rows])),
      { initialProps: { rows: ['user', 'child-reply'] } }
    )
    for (let window = 0; window < 10; window += 1) {
      view.rerender({ rows: windowAt(window * 300) })
    }
    view.rerender({ rows: [...windowAt(2700), 'child-reply'] })
    expect(view.result.current.begun.has('child-reply')).toBe(false)
  })

  it('bounds remembered rows to the loaded window across ten distinct 300-row windows', () => {
    const captured: Set<unknown>[] = []
    const OriginalSet = globalThis.Set
    class CapturedSet<T> extends OriginalSet<T> {
      constructor(values?: Iterable<T> | null) {
        super(values)
        captured.push(this)
      }
    }
    // Observe private retention without exposing bookkeeping to transcript consumers.
    vi.stubGlobal('Set', CapturedSet)
    const view = renderHook(({ rows }) => useNativeChatReplyReveals(rows, new Set(rows)), {
      initialProps: { rows: windowAt(0) }
    })
    vi.unstubAllGlobals()
    for (let window = 1; window < 10; window += 1) {
      view.rerender({ rows: windowAt(window * 300) })
    }
    const remembered = captured.find((set) => set.has('row-2700') && set.has('row-2999'))
    expect(remembered).toBeDefined()
    expect(remembered?.size).toBe(300)
    expect(remembered?.has('row-0')).toBe(false)
    expect(view.result.current.begun.size).toBe(1)
    expect(view.result.current.drawn.size).toBe(0)
    view.rerender({ rows: [] })
    expect(remembered?.size).toBe(0)
    expect(view.result.current.begun.size).toBe(0)
  })
})
