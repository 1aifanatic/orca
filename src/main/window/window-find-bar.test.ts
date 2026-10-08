import type { BrowserWindow } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  WINDOW_FIND_BAR_ACTIVATE_CHANNEL,
  WINDOW_FIND_BAR_CLOSE_CHANNEL,
  WINDOW_FIND_BAR_QUERY_CHANNEL,
  WINDOW_FIND_BAR_RESULT_CHANNEL,
  WINDOW_FIND_BAR_STEP_CHANNEL,
  WINDOW_FIND_OPEN_CHANNEL
} from '../../shared/window-find-bar-contract'

type IpcListener = (event: { sender: unknown; senderFrame?: unknown }, payload?: unknown) => void

const fakes = vi.hoisted(() => {
  class FakeEmitter {
    private listeners = new Map<string, ((...args: unknown[]) => void)[]>()
    on(event: string, listener: (...args: unknown[]) => void): this {
      this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener])
      return this
    }
    once(event: string, listener: (...args: unknown[]) => void): this {
      return this.on(event, listener)
    }
    emit(event: string, ...args: unknown[]): void {
      for (const listener of this.listeners.get(event) ?? []) {
        listener(...args)
      }
    }
  }
  class FakeWebContents extends FakeEmitter {
    mainFrame = { id: 'main-frame' }
    destroyed = false
    zoomFactor = 1
    loadingMainFrame = false
    lastRequestId = 0
    focus = vi.fn()
    send = vi.fn()
    close = vi.fn(() => {
      this.destroyed = true
    })
    loadURL = vi.fn(() => Promise.resolve())
    findInPage = vi.fn(() => ++this.lastRequestId)
    stopFindInPage = vi.fn()
    isDestroyed = (): boolean => this.destroyed
    getZoomFactor = (): number => this.zoomFactor
    isLoadingMainFrame = (): boolean => this.loadingMainFrame
  }
  const createdViews: FakeView[] = []
  class FakeView {
    webContents = new FakeWebContents()
    options: unknown
    setBounds = vi.fn()
    setVisible = vi.fn()
    setBackgroundColor = vi.fn()
    constructor(options: unknown) {
      this.options = options
      createdViews.push(this)
    }
  }
  return {
    ipcListeners: new Map<string, Set<IpcListener>>(),
    createdViews,
    FakeEmitter,
    FakeWebContents,
    FakeView
  }
})

const { ipcListeners, createdViews, FakeWebContents } = fakes
type FakeView = InstanceType<typeof fakes.FakeView>

vi.mock('electron', () => ({
  WebContentsView: fakes.FakeView,
  ipcMain: {
    on: (channel: string, listener: IpcListener) => {
      const listeners = ipcListeners.get(channel) ?? new Set()
      listeners.add(listener)
      ipcListeners.set(channel, listeners)
    },
    removeListener: (channel: string, listener: IpcListener) => {
      ipcListeners.get(channel)?.delete(listener)
    }
  }
}))

vi.mock('../i18n/main-i18n', () => ({
  translateMain: (_key: string, fallback: string) => fallback
}))

import { registerWindowFindBar, windowFindBarViewBounds } from './window-find-bar'

const FakeEmitterBase = fakes.FakeEmitter

class FakeWindow extends FakeEmitterBase {
  webContents = new FakeWebContents()
  destroyed = false
  contentView = { addChildView: vi.fn(), removeChildView: vi.fn() }
  isDestroyed = (): boolean => this.destroyed
  getContentBounds = (): {
    x: number
    y: number
    width: number
    height: number
  } => ({
    x: 0,
    y: 0,
    width: 1200,
    height: 800
  })
}

function emitIpc(
  channel: string,
  event: { sender: unknown; senderFrame?: unknown },
  payload?: unknown
): void {
  for (const listener of ipcListeners.get(channel) ?? []) {
    listener(event, payload)
  }
}

function setup(): {
  window: FakeWindow
  openFromApp: (payload?: unknown) => void
} {
  const window = new FakeWindow()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: FakeWindow implements every member registerWindowFindBar reads.
  registerWindowFindBar(window as unknown as BrowserWindow, '/preload.js')
  const openFromApp = (payload: unknown = { top: 40, rightInset: 300 }): void =>
    emitIpc(
      WINDOW_FIND_OPEN_CHANNEL,
      { sender: window.webContents, senderFrame: window.webContents.mainFrame },
      payload
    )
  return { window, openFromApp }
}

function openLoadedBar(): { window: FakeWindow; view: FakeView } {
  const { window, openFromApp } = setup()
  openFromApp()
  const view = createdViews[0]
  view.webContents.emit('did-finish-load')
  return { window, view }
}

beforeEach(() => {
  ipcListeners.clear()
  createdViews.length = 0
})

describe('windowFindBarViewBounds', () => {
  it('puts the bar top-right corner at the anchor, scaled by zoom', () => {
    expect(
      windowFindBarViewBounds({ width: 1200, height: 800 }, { top: 40, rightInset: 300 }, 1.5)
    ).toEqual({
      x: 1200 - 450 - 344,
      y: 60,
      width: 344,
      height: 48
    })
  })

  it('keeps the bar inside a window narrower than the anchor allows', () => {
    expect(
      windowFindBarViewBounds({ width: 300, height: 30 }, { top: 500, rightInset: 400 }, 1)
    ).toEqual({
      x: 0,
      y: 0,
      width: 300,
      height: 30
    })
  })
})

describe('registerWindowFindBar', () => {
  it('opens a sandboxed bar over the window and activates it once its page has loaded', () => {
    const { window, openFromApp } = setup()
    openFromApp()

    expect(createdViews).toHaveLength(1)
    const view = createdViews[0]
    expect(view.options).toMatchObject({
      webPreferences: {
        preload: '/preload.js',
        sandbox: true,
        contextIsolation: true
      }
    })
    expect(window.contentView.addChildView).toHaveBeenCalledWith(view)
    expect(view.setBounds).toHaveBeenCalledWith({
      x: 1200 - 300 - 344,
      y: 40,
      width: 344,
      height: 48
    })
    expect(view.webContents.send).not.toHaveBeenCalled()

    view.webContents.emit('did-finish-load')
    expect(view.webContents.focus).toHaveBeenCalled()
    expect(view.webContents.send).toHaveBeenCalledWith(
      WINDOW_FIND_BAR_ACTIVATE_CHANNEL,
      expect.objectContaining({ label: 'Find in window' })
    )
  })

  it('ignores open requests from anything but the app page itself', () => {
    const { window } = setup()
    emitIpc(WINDOW_FIND_OPEN_CHANNEL, { sender: new FakeWebContents() }, { top: 0, rightInset: 0 })
    emitIpc(
      WINDOW_FIND_OPEN_CHANNEL,
      { sender: window.webContents, senderFrame: { id: 'child-frame' } },
      { top: 0, rightInset: 0 }
    )
    emitIpc(
      WINDOW_FIND_OPEN_CHANNEL,
      { sender: window.webContents, senderFrame: window.webContents.mainFrame },
      { top: -1, rightInset: 0 }
    )
    expect(createdViews).toHaveLength(0)
  })

  it('searches the app window and relays only the latest request result to the bar', () => {
    const { window, view } = openLoadedBar()

    emitIpc(WINDOW_FIND_BAR_QUERY_CHANNEL, { sender: view.webContents }, { text: 'needle' })
    expect(window.webContents.findInPage).toHaveBeenLastCalledWith('needle', {
      forward: true,
      findNext: true
    })
    emitIpc(WINDOW_FIND_BAR_STEP_CHANNEL, { sender: view.webContents }, { forward: false })
    expect(window.webContents.findInPage).toHaveBeenLastCalledWith('needle', {
      forward: false,
      findNext: false
    })

    window.webContents.emit(
      'found-in-page',
      {},
      { requestId: 1, activeMatchOrdinal: 1, matches: 3 }
    )
    window.webContents.emit(
      'found-in-page',
      {},
      { requestId: 2, activeMatchOrdinal: 3, matches: 3 }
    )
    const results = view.webContents.send.mock.calls.filter(
      ([channel]) => channel === WINDOW_FIND_BAR_RESULT_CHANNEL
    )
    expect(results).toEqual([
      [WINDOW_FIND_BAR_RESULT_CHANNEL, { activeMatchOrdinal: 3, matches: 3 }]
    ])
  })

  it('refuses bar commands from any other sender', () => {
    const { window } = openLoadedBar()
    emitIpc(WINDOW_FIND_BAR_QUERY_CHANNEL, { sender: window.webContents }, { text: 'needle' })
    expect(window.webContents.findInPage).not.toHaveBeenCalled()
  })

  it('clears the highlight and hands focus back to the app on close', () => {
    const { window, view } = openLoadedBar()
    emitIpc(WINDOW_FIND_BAR_QUERY_CHANNEL, { sender: view.webContents }, { text: 'needle' })

    emitIpc(WINDOW_FIND_BAR_CLOSE_CHANNEL, { sender: view.webContents })

    expect(window.webContents.stopFindInPage).toHaveBeenCalledWith('clearSelection')
    expect(view.setVisible).toHaveBeenLastCalledWith(false)
    expect(window.webContents.focus).toHaveBeenCalled()
  })

  it('hides the bar when the app page reloads', () => {
    const { window, view } = openLoadedBar()
    window.webContents.loadingMainFrame = true
    window.webContents.emit('did-start-loading')
    expect(view.setVisible).toHaveBeenLastCalledWith(false)
    expect(window.webContents.focus).not.toHaveBeenCalled()
  })

  it('reuses one bar per window and re-runs no search on its own when reopened', () => {
    const { window, openFromApp } = setup()
    openFromApp()
    openFromApp({ top: 10, rightInset: 0 })
    expect(createdViews).toHaveLength(1)
    expect(createdViews[0].setBounds).toHaveBeenLastCalledWith({
      x: 1200 - 344,
      y: 10,
      width: 344,
      height: 48
    })
    expect(window.webContents.findInPage).not.toHaveBeenCalled()
  })

  it('drops its listeners and bar when the window closes', () => {
    const { window, view } = openLoadedBar()
    window.emit('closed')
    expect(view.webContents.close).toHaveBeenCalled()
    for (const channel of [WINDOW_FIND_OPEN_CHANNEL, WINDOW_FIND_BAR_QUERY_CHANNEL]) {
      expect(ipcListeners.get(channel)?.size ?? 0).toBe(0)
    }
  })
})
