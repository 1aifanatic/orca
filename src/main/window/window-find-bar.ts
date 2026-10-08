import { ipcMain, WebContentsView, type BrowserWindow, type IpcMainEvent } from 'electron'
import { join } from 'node:path'
import {
  WINDOW_FIND_BAR_ACTIVATE_CHANNEL,
  WINDOW_FIND_BAR_CLOSE_CHANNEL,
  WINDOW_FIND_BAR_QUERY_CHANNEL,
  WINDOW_FIND_BAR_RESULT_CHANNEL,
  WINDOW_FIND_BAR_STEP_CHANNEL,
  WINDOW_FIND_OPEN_CHANNEL,
  parseWindowFindBarQuery,
  parseWindowFindBarStep,
  parseWindowFindOpenRequest,
  type WindowFindBarLabels,
  type WindowFindBarResult,
  type WindowFindOpenRequest
} from '../../shared/window-find-bar-contract'
import { translateMain } from '../i18n/main-i18n'
import {
  WINDOW_FIND_BAR_VIEW_HEIGHT,
  WINDOW_FIND_BAR_VIEW_WIDTH,
  createWindowFindBarUrl
} from './window-find-bar-html'

type Bounds = { x: number; y: number; width: number; height: number }

/** Places the bar view so its top-right corner meets the requested anchor, kept inside the window. */
export function windowFindBarViewBounds(
  contentBounds: Pick<Bounds, 'width' | 'height'>,
  anchor: WindowFindOpenRequest,
  zoomFactor: number
): Bounds {
  const width = Math.min(WINDOW_FIND_BAR_VIEW_WIDTH, contentBounds.width)
  const height = Math.min(WINDOW_FIND_BAR_VIEW_HEIGHT, contentBounds.height)
  const right = contentBounds.width - anchor.rightInset * zoomFactor
  return {
    x: Math.round(Math.max(0, Math.min(right - width, contentBounds.width - width))),
    y: Math.round(Math.max(0, Math.min(anchor.top * zoomFactor, contentBounds.height - height))),
    width,
    height
  }
}

function windowFindBarLabels(): WindowFindBarLabels {
  return {
    label: translateMain('auto.main.window.findBar.label', 'Find in window'),
    previousMatch: translateMain('auto.main.window.findBar.previousMatch', 'Previous match'),
    nextMatch: translateMain('auto.main.window.findBar.nextMatch', 'Next match'),
    close: translateMain('auto.main.window.findBar.close', 'Close')
  }
}

type FindBar = {
  view: WebContentsView
  loaded: boolean
  visible: boolean
  query: string
  anchor: WindowFindOpenRequest
  activeRequestId: number | null
}

let releaseActiveWindowFindBar: (() => void) | null = null

/** Find in window for the main window: a separate view stacked over the app, searching it with Chromium's find. */
export function registerWindowFindBar(
  mainWindow: BrowserWindow,
  preloadPath = join(__dirname, 'window-find-bar-preload.js')
): void {
  // Why: macOS re-activation attaches a new window; the old window's channel listeners must go.
  releaseActiveWindowFindBar?.()
  const mainWebContents = mainWindow.webContents
  let bar: FindBar | null = null

  const isWindowGone = (): boolean => mainWindow.isDestroyed() || mainWebContents.isDestroyed()

  const stopFind = (current: FindBar): void => {
    current.activeRequestId = null
    if (!mainWebContents.isDestroyed()) {
      mainWebContents.stopFindInPage('clearSelection')
    }
  }

  const layout = (): void => {
    if (!bar?.visible || isWindowGone()) {
      return
    }
    bar.view.setBounds(
      windowFindBarViewBounds(
        mainWindow.getContentBounds(),
        bar.anchor,
        mainWebContents.getZoomFactor()
      )
    )
  }

  const activate = (current: FindBar): void => {
    if (current.loaded && !current.view.webContents.isDestroyed()) {
      current.view.webContents.focus()
      current.view.webContents.send(WINDOW_FIND_BAR_ACTIVATE_CHANNEL, windowFindBarLabels())
    }
  }

  const hide = (refocusApp: boolean): void => {
    if (!bar?.visible) {
      return
    }
    stopFind(bar)
    bar.visible = false
    bar.view.setVisible(false)
    if (refocusApp && !mainWebContents.isDestroyed()) {
      mainWebContents.focus()
    }
  }

  const ensureBar = (anchor: WindowFindOpenRequest): FindBar => {
    if (bar) {
      return bar
    }
    const view = new WebContentsView({
      webPreferences: {
        preload: preloadPath,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false
      }
    })
    view.setBackgroundColor('#00000000')
    const created: FindBar = {
      view,
      loaded: false,
      visible: false,
      query: '',
      anchor,
      activeRequestId: null
    }
    // Why: the page's listeners exist only after load, so the first open activates from here.
    view.webContents.once('did-finish-load', () => {
      created.loaded = true
      if (created.visible) {
        activate(created)
      }
    })
    void view.webContents.loadURL(createWindowFindBarUrl()).catch(() => {})
    bar = created
    return created
  }

  const open = (anchor: WindowFindOpenRequest): void => {
    if (isWindowGone()) {
      return
    }
    const current = ensureBar(anchor)
    current.anchor = anchor
    // Re-adding keeps the bar above any view added since it was created.
    mainWindow.contentView.removeChildView(current.view)
    mainWindow.contentView.addChildView(current.view)
    current.visible = true
    current.view.setVisible(true)
    layout()
    activate(current)
  }

  const fromBar = (event: IpcMainEvent): FindBar | null =>
    bar && !bar.view.webContents.isDestroyed() && event.sender === bar.view.webContents ? bar : null

  const onOpen = (event: IpcMainEvent, payload: unknown): void => {
    if (
      isWindowGone() ||
      event.sender !== mainWebContents ||
      event.senderFrame !== mainWebContents.mainFrame
    ) {
      return
    }
    const request = parseWindowFindOpenRequest(payload)
    if (request) {
      open(request)
    }
  }
  const onQuery = (event: IpcMainEvent, payload: unknown): void => {
    const current = fromBar(event)
    const request = parseWindowFindBarQuery(payload)
    if (!current || !request || isWindowGone()) {
      return
    }
    current.query = request.text
    if (request.text.length === 0) {
      stopFind(current)
      return
    }
    current.activeRequestId = mainWebContents.findInPage(request.text, {
      forward: true,
      findNext: true
    })
  }
  const onStep = (event: IpcMainEvent, payload: unknown): void => {
    const current = fromBar(event)
    const request = parseWindowFindBarStep(payload)
    if (!current || !request || current.query.length === 0 || isWindowGone()) {
      return
    }
    current.activeRequestId = mainWebContents.findInPage(current.query, {
      forward: request.forward,
      findNext: false
    })
  }
  const onClose = (event: IpcMainEvent): void => {
    if (fromBar(event)) {
      hide(true)
    }
  }
  const onFoundInPage = (_event: unknown, result: Electron.Result): void => {
    if (!bar || bar.activeRequestId !== result.requestId || bar.view.webContents.isDestroyed()) {
      return
    }
    bar.view.webContents.send(WINDOW_FIND_BAR_RESULT_CHANNEL, {
      activeMatchOrdinal: Math.max(0, result.activeMatchOrdinal),
      matches: Math.max(0, result.matches)
    } satisfies WindowFindBarResult)
  }
  // Why: a reload or crash replaces the page the matches pointed into.
  const onDidStartLoading = (): void => {
    if (mainWebContents.isLoadingMainFrame()) {
      hide(false)
    }
  }
  const onRenderProcessGone = (): void => hide(false)

  ipcMain.on(WINDOW_FIND_OPEN_CHANNEL, onOpen)
  ipcMain.on(WINDOW_FIND_BAR_QUERY_CHANNEL, onQuery)
  ipcMain.on(WINDOW_FIND_BAR_STEP_CHANNEL, onStep)
  ipcMain.on(WINDOW_FIND_BAR_CLOSE_CHANNEL, onClose)
  mainWebContents.on('found-in-page', onFoundInPage)
  mainWebContents.on('did-start-loading', onDidStartLoading)
  mainWebContents.on('render-process-gone', onRenderProcessGone)
  mainWindow.on('resize', layout)
  mainWindow.on('enter-full-screen', layout)
  mainWindow.on('leave-full-screen', layout)

  const release = (): void => {
    ipcMain.removeListener(WINDOW_FIND_OPEN_CHANNEL, onOpen)
    ipcMain.removeListener(WINDOW_FIND_BAR_QUERY_CHANNEL, onQuery)
    ipcMain.removeListener(WINDOW_FIND_BAR_STEP_CHANNEL, onStep)
    ipcMain.removeListener(WINDOW_FIND_BAR_CLOSE_CHANNEL, onClose)
    if (bar && !bar.view.webContents.isDestroyed()) {
      bar.view.webContents.close()
    }
    bar = null
    if (releaseActiveWindowFindBar === release) {
      releaseActiveWindowFindBar = null
    }
  }
  releaseActiveWindowFindBar = release
  mainWindow.on('closed', release)
}
