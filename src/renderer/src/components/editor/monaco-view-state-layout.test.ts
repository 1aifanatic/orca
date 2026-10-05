// @vitest-environment happy-dom
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js'
import { editorSelectionCache, scrollTopCache } from '@/lib/scroll-cache'
import { restoreMonacoViewState } from './monaco-view-state-persistence'

const frames = new Map<number, FrameRequestCallback>()
const cleanups: (() => void)[] = []
const canvasContext = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'getContext')
let nextFrame = 0

beforeAll(() => {
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    value: () => ({
      webkitBackingStorePixelRatio: 1,
      measureText: (text: string) => ({ width: text.length * 8 }),
      clearRect: () => {},
      fillRect: () => {},
      beginPath: () => {},
      moveTo: () => {},
      lineTo: () => {},
      stroke: () => {}
    })
  })
})
afterAll(() => {
  if (canvasContext) {
    Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', canvasContext)
  }
})
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup())
  frames.clear()
  editorSelectionCache.clear()
  scrollTopCache.clear()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function createEditor(width = 800) {
  const container = document.createElement('div')
  document.body.append(container)
  const model = monaco.editor.createModel(
    Array.from({ length: 100 }, () => 'some text').join('\n'),
    'plaintext'
  )
  const instance = monaco.editor.create(container, {
    model,
    dimension: { width, height: 300 },
    automaticLayout: false,
    minimap: { enabled: false },
    occurrencesHighlight: 'off',
    selectionHighlight: false
  })
  cleanups.push(() => {
    instance.dispose()
    model.dispose()
    container.remove()
  })
  return { instance, model }
}
function pauseFrames() {
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback): number => {
    const frame = ++nextFrame
    frames.set(frame, callback)
    return frame
  })
  vi.stubGlobal('cancelAnimationFrame', (frame: number) => frames.delete(frame))
}
function flushFrames() {
  const queued = [...frames]
  frames.clear()
  queued.forEach(([, callback]) => callback(0))
}
function subscriptions(instance: monaco.editor.IStandaloneCodeEditor) {
  const spies = [
    vi.spyOn(instance, 'onDidDispose'),
    vi.spyOn(instance, 'onDidChangeModel'),
    vi.spyOn(instance, 'onDidLayoutChange')
  ]
  return () =>
    spies.map((subscribe) => {
      const subscription = subscribe.mock.results[0]
      if (subscription?.type !== 'return') {
        throw new Error('Expected a restore subscription')
      }
      return vi.spyOn(subscription.value, 'dispose')
    })
}

describe('real Monaco view-state layout boundary', () => {
  it('waits without polling for hidden editor layout and releases one-shot listeners on reveal', () => {
    const target = createEditor(0)
    const selection = new monaco.Selection(80, 7, 75, 2)
    editorSelectionCache.set('file.ts::pane-a', [selection])
    scrollTopCache.set('file.ts::pane-a', 1200)
    const scroll = vi.spyOn(target.instance, 'setScrollTop')
    const focus = vi.spyOn(target.instance, 'focus')
    const trackSubscriptions = subscriptions(target.instance)
    pauseFrames()
    restoreMonacoViewState(target.instance, 'file.ts::pane-a')
    const unsubscribe = trackSubscriptions()
    flushFrames()
    expect(scroll).not.toHaveBeenCalled()
    expect(focus).not.toHaveBeenCalled()
    expect(frames.size).toBe(0)
    target.instance.layout({ width: 800, height: 300 })
    flushFrames()
    expect(target.instance.getSelection()).toEqual(selection)
    expect(scroll).toHaveBeenCalledExactlyOnceWith(1200)
    expect(focus).toHaveBeenCalledOnce()
    unsubscribe.forEach((dispose) => expect(dispose).toHaveBeenCalledOnce())
    target.instance.layout({ width: 900, height: 300 })
    expect(frames.size).toBe(0)
    expect(target.model.getValue()).toContain('some text')
  })

  it('cancels an editor that never gains usable dimensions', () => {
    const target = createEditor(0)
    scrollTopCache.set('file.ts', 1200)
    const scroll = vi.spyOn(target.instance, 'setScrollTop')
    const trackSubscriptions = subscriptions(target.instance)
    pauseFrames()
    restoreMonacoViewState(target.instance, 'file.ts')
    const unsubscribe = trackSubscriptions()
    flushFrames()
    target.instance.dispose()
    expect(frames.size).toBe(0)
    unsubscribe.forEach((dispose) => expect(dispose).toHaveBeenCalledOnce())
    expect(scroll).not.toHaveBeenCalled()
  })

  it('rejects an old-model restore after model disposal or replacement', () => {
    for (const disposeModel of [true, false]) {
      const target = createEditor(0)
      scrollTopCache.set('file.ts', 1200)
      const scroll = vi.spyOn(target.instance, 'setScrollTop')
      const focus = vi.spyOn(target.instance, 'focus')
      const trackSubscriptions = subscriptions(target.instance)
      pauseFrames()
      restoreMonacoViewState(target.instance, 'file.ts')
      const unsubscribe = trackSubscriptions()
      flushFrames()
      if (disposeModel) {
        target.model.dispose()
      } else {
        target.instance.setModel(null)
      }
      target.instance.layout({ width: 800, height: 300 })
      flushFrames()
      expect(scroll).not.toHaveBeenCalled()
      expect(focus).not.toHaveBeenCalled()
      unsubscribe.forEach((dispose) => expect(dispose).toHaveBeenCalledOnce())
    }
  })

  it('restores only the final A in a rapid A to B to A switch', () => {
    const first = createEditor(0)
    const second = createEditor(0)
    const last = createEditor()
    scrollTopCache.set('a.ts', 1200)
    scrollTopCache.set('b.ts', 300)
    const firstFocus = vi.spyOn(first.instance, 'focus')
    const secondFocus = vi.spyOn(second.instance, 'focus')
    const lastScroll = vi.spyOn(last.instance, 'setScrollTop')
    pauseFrames()
    restoreMonacoViewState(first.instance, 'a.ts')
    restoreMonacoViewState(second.instance, 'b.ts')
    const staleFrames = [...frames.values()]
    first.instance.dispose()
    second.instance.dispose()
    restoreMonacoViewState(last.instance, 'a.ts')
    staleFrames.forEach((callback) => callback(0))
    flushFrames()
    expect(firstFocus).not.toHaveBeenCalled()
    expect(secondFocus).not.toHaveBeenCalled()
    expect(lastScroll).toHaveBeenCalledExactlyOnceWith(1200)
  })

  it('keeps same-file pane positions and model identity separate', () => {
    const first = createEditor()
    const sibling = createEditor()
    const selection = new monaco.Selection(80, 7, 75, 2)
    editorSelectionCache.set('file.ts::pane-a', [selection])
    scrollTopCache.set('file.ts::pane-a', 1200)
    scrollTopCache.set('file.ts::pane-b', 600)
    const firstScroll = vi.spyOn(first.instance, 'setScrollTop')
    const siblingScroll = vi.spyOn(sibling.instance, 'setScrollTop')
    pauseFrames()
    restoreMonacoViewState(first.instance, 'file.ts::pane-a')
    restoreMonacoViewState(sibling.instance, 'file.ts::pane-b')
    flushFrames()
    expect(first.instance.getSelection()).toEqual(selection)
    expect(firstScroll).toHaveBeenCalledExactlyOnceWith(1200)
    expect(siblingScroll).toHaveBeenCalledExactlyOnceWith(600)
    expect(first.instance.getModel()).toBe(first.model)
    expect(sibling.instance.getModel()).toBe(sibling.model)
    expect(first.model.canUndo()).toBe(false)
  })
})
