/**
 * A remote browser stream keeps the desktop window drawing for exactly as long as it lives: guest
 * frames come from the embedder's compositor, which a throttled hidden window stops running.
 */
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

function createCommandsHost(): RuntimeBrowserCommandHost {
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
    getAvailableAuthoritativeWindow: vi.fn(() => null),
    getOffscreenBrowserBackend: vi.fn(() => null)
  } as unknown as RuntimeBrowserCommandHost
}

type PageStream = { options: BrowserScreencastOptions; close: () => void }

function createRig() {
  const { runtime } = createScreencastHarness()
  const setBackgroundThrottling = vi.fn()
  const window = { webContents: { isDestroyed: () => false, setBackgroundThrottling } }
  Object.assign(runtime, {
    browserCommands: new RuntimeBrowserCommands(createCommandsHost()),
    getAvailableAuthoritativeWindow: () => window
  })
  const pageStreams: PageStream[] = []
  startBrowserScreencast.mockImplementation(
    async (_guest: unknown, options: BrowserScreencastOptions) => {
      let close!: () => void
      const done = new Promise<void>((resolve) => {
        close = resolve
      })
      pageStreams.push({ options, close })
      return {
        stop: () => close(),
        done,
        updateViewport: vi.fn(async () => {}),
        updateFrameBudget: vi.fn(async () => {})
      }
    }
  )

  const subscribe = (connectionId: string, sendBinary = vi.fn(() => true)) => {
    const emit = vi.fn()
    const done = runtime.browserScreencast(
      { worktree: 'id:wt-1', page: 'page-1', format: 'jpeg' },
      { connectionId, clientKind: 'mobile', sendBinary, emit }
    )
    const ready = async (): Promise<string> => {
      await vi.waitFor(() =>
        expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'ready' }))
      )
      return emit.mock.calls.find(([event]) => event.type === 'ready')?.[0].subscriptionId
    }
    return { done, ready, emit }
  }

  return {
    runtime,
    subscribe,
    pageStreams,
    // The window draws while hidden only after its last setBackgroundThrottling was `false`.
    lifted: () => setBackgroundThrottling.mock.calls.at(-1)?.[0] === false,
    throttleCalls: () => setBackgroundThrottling.mock.calls.map(([allowed]) => allowed)
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
})
