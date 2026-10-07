/**
 * A remote browser stream keeps the desktop window drawing for exactly as long as it lives: guest
 * frames come from the embedder's compositor, which a throttled hidden window stops running.
 */
import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentBrowserBridge } from '../browser/agent-browser-bridge'
import type { BrowserScreencastOptions } from '../browser/browser-screencast-stream-types'
import { BROWSER_SCREENCAST_GHOST_SUBSCRIBER_REFUSAL_LIMIT } from './browser-screencast-ghost-subscriber-eviction'
import { createScreencastHarness } from './browser-screencast-subscriber-test-harness'
import type { RuntimeBrowserCommandHost } from './orca-runtime-browser'
import { RuntimeBrowserCommands } from './orca-runtime-browser'
import { RuntimeBrowserPageRegistry } from './runtime-browser-page-registry'

const { webContentsFromId, startBrowserScreencast } = vi.hoisted(() => ({
  webContentsFromId: vi.fn(),
  startBrowserScreencast: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: { on: vi.fn(), removeListener: vi.fn(), handle: vi.fn(), removeHandler: vi.fn() },
  webContents: { fromId: webContentsFromId }
}))
vi.mock('../browser/browser-screencast-stream', () => ({ startBrowserScreencast }))

function createCommandsHost(window: EventEmitter): RuntimeBrowserCommandHost {
  const runtimeBrowserPages = new RuntimeBrowserPageRegistry()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: screencast reads only these bridge members.
  const bridge = {
    getRegisteredTabs: vi.fn(() => new Map([['page-1', 100]])),
    getActivePageId: vi.fn(() => 'page-1'),
    tabList: vi.fn(() => ({
      tabs: [
        { browserPageId: 'page-1', index: 0, url: 'about:blank', title: 'Browser', active: true }
      ]
    }))
  } as unknown as AgentBrowserBridge
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: screencast reads only these host members.
  return {
    resolveWorktreeSelector: async () => ({ id: 'wt-1' }),
    getAgentBrowserBridge: () => bridge,
    getRuntimeBrowserPageRegistry: () => runtimeBrowserPages,
    getAvailableAuthoritativeWindow: vi.fn(() => window),
    getOffscreenBrowserBackend: vi.fn(() => null)
  } as unknown as RuntimeBrowserCommandHost
}

type PageStream = {
  options: BrowserScreencastOptions
  close: () => void
  stop: ReturnType<typeof vi.fn>
}

function createRig() {
  const { runtime } = createScreencastHarness()
  const setBackgroundThrottling = vi.fn()
  const window = Object.assign(new EventEmitter(), {
    webContents: { isDestroyed: () => false, setBackgroundThrottling }
  })
  const guest = { isDestroyed: () => false, setBackgroundThrottling: vi.fn() }
  webContentsFromId.mockReturnValue(guest)
  Object.assign(runtime, {
    browserCommands: new RuntimeBrowserCommands(createCommandsHost(window)),
    getAvailableAuthoritativeWindow: () => window
  })
  const pageStreams: PageStream[] = []
  // Models Chromium's asynchronous teardown: a held stop leaves the stream open until `close()`.
  const stopControl = { hold: false }
  startBrowserScreencast.mockImplementation(
    async (_guest: unknown, options: BrowserScreencastOptions) => {
      let close!: () => void
      const done = new Promise<void>((resolve) => {
        close = resolve
      })
      const stop = vi.fn(() => {
        if (!stopControl.hold) {
          close()
        }
      })
      pageStreams.push({ options, close, stop })
      return {
        stop,
        done,
        updateViewport: vi.fn(async () => {}),
        updateFrameBudget: vi.fn(async () => {})
      }
    }
  )

  const subscribe = (
    connectionId: string,
    sendBinary = vi.fn(() => true),
    signal?: AbortSignal
  ) => {
    const emit = vi.fn()
    const done = runtime.browserScreencast(
      { worktree: 'id:wt-1', page: 'page-1', format: 'jpeg' },
      { connectionId, clientKind: 'mobile', sendBinary, signal, emit }
    )
    const ready = async (): Promise<string> => {
      await vi.waitFor(() =>
        expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'ready' }))
      )
      return emit.mock.calls.find(([event]) => event.type === 'ready')?.[0].subscriptionId
    }
    const eventTypes = (): string[] => emit.mock.calls.map(([event]) => event.type)
    return { done, ready, emit, eventTypes }
  }

  return {
    runtime,
    subscribe,
    pageStreams,
    stopControl,
    // The window draws while hidden only after its last setBackgroundThrottling was `false`.
    lifted: () => setBackgroundThrottling.mock.calls.at(-1)?.[0] === false,
    throttleCalls: () => setBackgroundThrottling.mock.calls.map(([allowed]) => allowed),
    window,
    guestThrottleCalls: () => guest.setBackgroundThrottling.mock.calls.map(([allowed]) => allowed)
  }
}

describe('remote browser screencast renderer throttle lease', () => {
  beforeEach(() => {
    webContentsFromId.mockReset()
    webContentsFromId.mockReturnValue({ isDestroyed: () => false })
    startBrowserScreencast.mockReset()
  })

  it('lifts the window throttle before the stream starts capturing', async () => {
    const rig = createRig()
    let liftedAtStart: boolean | null = null
    const started = startBrowserScreencast.getMockImplementation()
    startBrowserScreencast.mockImplementation(async (...args: unknown[]) => {
      liftedAtStart = rig.lifted()
      return started?.(...args)
    })

    const phone = rig.subscribe('conn-phone')
    await phone.ready()

    expect(liftedAtStart).toBe(true)
    expect(rig.lifted()).toBe(true)
  })

  it('restores it when the phone unsubscribes', async () => {
    const rig = createRig()
    const phone = rig.subscribe('conn-phone')
    const subscriptionId = await phone.ready()

    rig.runtime.cleanupSubscription(subscriptionId)
    await phone.done

    expect(rig.throttleCalls()).toEqual([false, true])
  })

  it('restores it when the connection closes or is reaped', async () => {
    const rig = createRig()
    const phone = rig.subscribe('conn-phone')
    await phone.ready()

    rig.runtime.cleanupSubscriptionsForConnection('conn-phone')
    await phone.done

    expect(rig.throttleCalls()).toEqual([false, true])
  })

  it('restores it when the subscriber is evicted as a ghost', async () => {
    const rig = createRig()
    const sendBinary = vi.fn(() => true)
    const phone = rig.subscribe('conn-phone', sendBinary)
    await phone.ready()
    const { onFrame } = rig.pageStreams[0].options
    onFrame(new Uint8Array([1]))
    sendBinary.mockReturnValue(false)

    for (let i = 0; i < BROWSER_SCREENCAST_GHOST_SUBSCRIBER_REFUSAL_LIMIT; i += 1) {
      onFrame(new Uint8Array([1]))
    }
    await phone.done

    expect(rig.throttleCalls()).toEqual([false, true])
  })

  it('restores it when the desktop closes the page', async () => {
    const rig = createRig()
    const phone = rig.subscribe('conn-phone')
    await phone.ready()

    rig.pageStreams[0].close()
    await phone.done

    expect(rig.throttleCalls()).toEqual([false, true])
  })

  it('restores it when the stream errors out', async () => {
    const rig = createRig()
    const phone = rig.subscribe('conn-phone')
    await phone.ready()

    rig.pageStreams[0].options.onError?.('Browser debugger detached while streaming.')
    rig.pageStreams[0].close()
    await phone.done

    expect(phone.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }))
    expect(rig.throttleCalls()).toEqual([false, true])
  })

  it('restores it when the stream fails to start', async () => {
    const rig = createRig()
    startBrowserScreencast.mockRejectedValue(new Error('Could not attach debugger.'))
    const phone = rig.subscribe('conn-phone')

    await expect(phone.done).rejects.toThrow('Could not attach debugger.')

    expect(rig.throttleCalls()).toEqual([false, true])
  })

  it('stays lifted until the last of two subscribers leaves', async () => {
    const rig = createRig()
    const phone = rig.subscribe('conn-phone')
    const phoneSubscription = await phone.ready()
    const tablet = rig.subscribe('conn-tablet')
    const tabletSubscription = await tablet.ready()

    rig.runtime.cleanupSubscription(phoneSubscription)
    await phone.done
    expect(rig.throttleCalls()).toEqual([false])

    rig.runtime.cleanupSubscription(tabletSubscription)
    await tablet.done
    expect(rig.throttleCalls()).toEqual([false, true])
  })

  it('ends the stream on the no-frame timeout, then restores the throttle', async () => {
    const rig = createRig()
    const phone = rig.subscribe('conn-phone')
    await phone.ready()

    rig.pageStreams[0].options.onError?.('Browser stream timed out.')
    await phone.done

    expect(rig.pageStreams[0].stop).toHaveBeenCalledOnce()
    expect(phone.eventTypes()).toEqual(['ready', 'error', 'end'])
    expect(rig.throttleCalls()).toEqual([false, true])
  })

  it('starts a fresh stream for a viewer that joins while the timed-out one tears down', async () => {
    const rig = createRig()
    const phone = rig.subscribe('conn-phone')
    await phone.ready()
    rig.stopControl.hold = true

    rig.pageStreams[0].options.onError?.('Browser stream timed out.')
    const guestLookups = webContentsFromId.mock.calls.length
    const tablet = rig.subscribe('conn-tablet')
    // Past its guest lookup, the joiner reaches the page record with no further await.
    await vi.waitFor(() =>
      expect(webContentsFromId.mock.calls.length).toBeGreaterThan(guestLookups)
    )
    await new Promise((resolve) => setImmediate(resolve))
    rig.pageStreams[0].close()
    await tablet.ready()

    expect(startBrowserScreencast).toHaveBeenCalledTimes(2)
    expect(tablet.eventTypes()).toEqual(['ready'])
    await phone.done
  })

  it('restores it when the subscription is aborted before ready', async () => {
    const rig = createRig()
    let releaseStart!: () => void
    const started = startBrowserScreencast.getMockImplementation()
    startBrowserScreencast.mockImplementation(async (...args: unknown[]) => {
      await new Promise<void>((resolve) => {
        releaseStart = resolve
      })
      return started?.(...args)
    })
    const abort = new AbortController()
    const phone = rig.subscribe(
      'conn-phone',
      vi.fn(() => true),
      abort.signal
    )
    await vi.waitFor(() => expect(releaseStart).toBeTypeOf('function'))

    abort.abort()
    releaseStart()
    await phone.done

    expect(phone.eventTypes()).not.toContain('ready')
    expect(rig.throttleCalls()).toEqual([false, true])
  })

  it('stays balanced when the same connection re-subscribes', async () => {
    const rig = createRig()
    const first = rig.subscribe('conn-phone')
    await first.ready()
    const second = rig.subscribe('conn-phone')
    const subscriptionId = await second.ready()
    await first.done
    expect(rig.lifted()).toBe(true)

    rig.runtime.cleanupSubscription(subscriptionId)
    await second.done

    const calls = rig.throttleCalls()
    expect(calls.filter((allowed) => !allowed)).toHaveLength(calls.filter(Boolean).length)
    expect(rig.lifted()).toBe(false)
  })
})

describe('remote browser screencast guest painting', () => {
  beforeEach(() => {
    webContentsFromId.mockReset()
    startBrowserScreencast.mockReset()
  })

  it('unthrottles the guest before the stream starts capturing', async () => {
    const rig = createRig()
    let guestCallsAtStart: boolean[] = []
    const started = startBrowserScreencast.getMockImplementation()
    startBrowserScreencast.mockImplementation(async (...args: unknown[]) => {
      guestCallsAtStart = rig.guestThrottleCalls()
      return started?.(...args)
    })

    const phone = rig.subscribe('conn-phone')
    await phone.ready()

    expect(guestCallsAtStart).toEqual([false])
  })

  it('unthrottles the guest again when the window hides or minimizes mid-stream', async () => {
    const rig = createRig()
    const phone = rig.subscribe('conn-phone')
    await phone.ready()

    rig.window.emit('hide')
    rig.window.emit('minimize')

    expect(rig.guestThrottleCalls()).toEqual([false, false, false])
  })

  it('applies once per page stream, not once per viewer', async () => {
    const rig = createRig()
    const phone = rig.subscribe('conn-phone')
    await phone.ready()
    const tablet = rig.subscribe('conn-tablet')
    await tablet.ready()

    rig.window.emit('hide')

    expect(rig.guestThrottleCalls()).toEqual([false, false])
  })

  it('leaves the guest alone while no stream is live', async () => {
    const rig = createRig()
    rig.window.emit('hide')
    rig.window.emit('minimize')
    expect(rig.guestThrottleCalls()).toEqual([])

    const phone = rig.subscribe('conn-phone')
    const subscriptionId = await phone.ready()
    rig.runtime.cleanupSubscription(subscriptionId)
    await phone.done
    // The page stream drops its window listeners once Chromium's stream has closed.
    await vi.waitFor(() => expect(rig.window.listenerCount('hide')).toBe(0))
    expect(rig.window.listenerCount('minimize')).toBe(0)
    rig.window.emit('hide')
    rig.window.emit('minimize')

    expect(rig.guestThrottleCalls()).toEqual([false])
  })

  it('makes no further guest call when the stream ends', async () => {
    const rig = createRig()
    const phone = rig.subscribe('conn-phone')
    const subscriptionId = await phone.ready()

    rig.runtime.cleanupSubscription(subscriptionId)
    await phone.done

    expect(rig.guestThrottleCalls()).toEqual([false])
    expect(rig.throttleCalls()).toEqual([false, true])
  })
})
