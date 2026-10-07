/**
 * A hidden, throttled embedder stops compositing, and then both capturePage and
 * Page.captureScreenshot neither resolve nor reject. The stream must give up and say so.
 */
import { Buffer } from 'node:buffer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startBrowserScreencast } from './browser-screencast-stream'
import type { BrowserScreencastOptions } from './browser-screencast-stream-types'
import { createMockScreencastWebContents } from './browser-screencast-web-contents-test-double'

function never<T>(): Promise<T> {
  return new Promise<T>(() => {})
}

function start(webContents: object, options: BrowserScreencastOptions) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stream touches only the debugger, isDestroyed and capturePage the doubles provide.
  return startBrowserScreencast(webContents as never, options)
}

function startOptions(viewport: boolean) {
  return {
    format: 'jpeg' as const,
    quality: 70,
    maxWidth: 1440,
    maxHeight: 1200,
    everyNthFrame: 2,
    minFrameIntervalMs: 0,
    ...(viewport ? { viewportWidth: 390, viewportHeight: 844 } : {}),
    onFrame: vi.fn(() => true),
    onError: vi.fn()
  }
}

describe('browser screencast first-frame capture time limit', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('reports a failure and ends the stream when both captures hang', async () => {
    const webContents = Object.assign(createMockScreencastWebContents(), {
      capturePage: vi.fn(() => never())
    })
    webContents.debugger.sendCommand.mockImplementation(async (method: string) =>
      method === 'Page.captureScreenshot' ? never() : {}
    )
    const options = startOptions(true)
    const session = await start(webContents, options)
    let ended = false
    void session.done.then(() => {
      ended = true
    })

    await vi.advanceTimersByTimeAsync(9_999)
    expect(options.onError).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)

    expect(options.onError).toHaveBeenCalledOnce()
    expect(ended).toBe(true)
    expect(webContents.debugger.sendCommand).toHaveBeenCalledWith('Page.stopScreencast', {})
    expect(options.onFrame).not.toHaveBeenCalled()
  })

  it('reports a failure when the screenshot fallback gives up without a frame', async () => {
    const webContents = createMockScreencastWebContents()
    webContents.debugger.sendCommand.mockImplementation(async (method: string) =>
      method === 'Page.captureScreenshot' ? never() : {}
    )
    const options = startOptions(false)
    const session = await start(webContents, options)

    await vi.advanceTimersByTimeAsync(10_000)

    expect(options.onError).toHaveBeenCalledOnce()
    await expect(session.done).resolves.toBeUndefined()
  })

  it('drops a capture that settles after the limit', async () => {
    let settleCapture!: (image: unknown) => void
    const webContents = Object.assign(createMockScreencastWebContents(), {
      capturePage: vi.fn(
        () =>
          new Promise((resolve) => {
            settleCapture = resolve
          })
      )
    })
    const options = startOptions(true)
    const session = await start(webContents, options)
    await vi.advanceTimersByTimeAsync(10_000)
    await session.done

    settleCapture({
      getSize: () => ({ width: 390, height: 844 }),
      toJPEG: () => Buffer.from('late'),
      toPNG: () => Buffer.from('late')
    })
    await vi.advanceTimersByTimeAsync(1_000)

    expect(options.onFrame).not.toHaveBeenCalled()
  })

  it('leaves the stream alone when a live frame arrived first', async () => {
    const webContents = Object.assign(createMockScreencastWebContents(), {
      capturePage: vi.fn(() => never())
    })
    const options = startOptions(true)
    const session = await start(webContents, options)
    webContents.debugger.emit('message', {}, 'Page.screencastFrame', {
      data: Buffer.from('live').toString('base64'),
      sessionId: 1,
      metadata: { deviceWidth: 390, deviceHeight: 844, pageScaleFactor: 1 }
    })

    await vi.advanceTimersByTimeAsync(10_000)

    expect(options.onFrame).toHaveBeenCalledOnce()
    expect(options.onError).not.toHaveBeenCalled()
    session.stop()
    await session.done
  })

  it('stays quiet when the capture answers in time', async () => {
    const webContents = createMockScreencastWebContents()
    webContents.debugger.sendCommand.mockImplementation(async (method: string) =>
      method === 'Page.captureScreenshot' ? { data: Buffer.from('frame').toString('base64') } : {}
    )
    const options = startOptions(false)
    const session = await start(webContents, options)

    await vi.advanceTimersByTimeAsync(30_000)

    expect(options.onFrame).toHaveBeenCalledOnce()
    expect(options.onError).not.toHaveBeenCalled()
    session.stop()
    await session.done
  })
})
