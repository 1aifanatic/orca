// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('../components/terminal/terminal-provider-snapshot-capability', () => ({
  collectTerminalProviderSnapshotPtyIds: () => [],
  refreshTerminalProviderSnapshotCapabilities: async () => undefined
}))
vi.mock('../store', async () => {
  const { create } = await import('zustand')
  const useAppStore = create(() => ({
    startupWorktreeRefreshCompleted: false,
    terminalStartupRestorationReady: false,
    workspaceSessionReady: false,
    applyTerminalTopologySlices: vi.fn()
  }))
  return { useAppStore }
})

import { useAppStore } from '../store'
import { recoverFromDegradedStartup } from './startup-degraded-recovery'

function recover(args: {
  isCancelled: () => boolean
  reconnectPersistedTerminals: () => Promise<void>
  terminalTopologyFollowed?: boolean
}): Promise<void> {
  return recoverFromDegradedStartup({
    error: new Error('hydration failed'),
    uiHydrated: true,
    reconnectStarted: false,
    terminalTopologyFollowed: true,
    hydratePersistedUI: vi.fn(),
    abortSignal: new AbortController().signal,
    ...args
  })
}

const SLICE = { worktreeId: 'repo::/wt', publishSeq: 3 }

describe('recoverFromDegradedStartup', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    useAppStore.setState({ terminalStartupRestorationReady: false, workspaceSessionReady: false })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        app: {
          awaitFirstWindowStartupServices: async () => undefined,
          recoverLegacyWorkerTerminalsForRendererStartup: async () => undefined,
          relaunch: vi.fn()
        },
        session: {
          onTerminalTopologyChanged: vi.fn(() => () => undefined),
          getTerminalTopologySlices: async () => [SLICE]
        }
      }
    })
  })

  it('releases terminal startup restoration once the degraded reconnect succeeds', async () => {
    await recover({
      isCancelled: () => false,
      reconnectPersistedTerminals: async () => {
        useAppStore.setState({ workspaceSessionReady: true })
      }
    })

    expect(useAppStore.getState().terminalStartupRestorationReady).toBe(true)
  })

  it('leaves the flag to the newer pass when this one was cancelled mid-reconnect', async () => {
    let cancelled = false
    await recover({
      isCancelled: () => cancelled,
      reconnectPersistedTerminals: async () => {
        cancelled = true
      }
    })

    expect(useAppStore.getState().terminalStartupRestorationReady).toBe(false)
  })

  it("follows main's terminal topology when startup failed before the follow began", async () => {
    await recover({
      isCancelled: () => false,
      reconnectPersistedTerminals: async () => undefined,
      terminalTopologyFollowed: false
    })

    expect(window.api.session.onTerminalTopologyChanged).toHaveBeenCalledTimes(1)
    expect(useAppStore.getState().applyTerminalTopologySlices).toHaveBeenCalledWith([SLICE])
  })

  it('does not follow twice when the success path already follows', async () => {
    await recover({
      isCancelled: () => false,
      reconnectPersistedTerminals: async () => undefined
    })

    expect(window.api.session.onTerminalTopologyChanged).not.toHaveBeenCalled()
  })
})
