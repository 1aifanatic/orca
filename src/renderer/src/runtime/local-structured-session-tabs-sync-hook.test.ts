// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  start: vi.fn(async () => undefined),
  hostInstalled: false,
  isWebClient: false,
  installedListener: null as null | (() => void)
}))

vi.mock('./local-structured-session-tabs-sync/subscription', () => ({
  startLocalStructuredSessionTabsSync: mocks.start
}))
vi.mock('@/lib/web-client-location', () => ({ isWebClientLocation: () => mocks.isWebClient }))

import { useAppStore } from '../store'
import { useLocalStructuredSessionTabsSync } from './local-structured-session-tabs-sync'
import { resetLocalStructuredChatsForTests } from './local-structured-chats'

function setStructuredChat(enabled: boolean): void {
  useAppStore.setState({
    settings: { ...useAppStore.getState().settings!, experimentalStructuredNativeChat: enabled }
  })
}

async function mountSync(): Promise<void> {
  renderHook(() => useLocalStructuredSessionTabsSync())
  // The host is asked whether it holds chats; its answer lands on the next tick.
  await act(async () => {
    await Promise.resolve()
  })
}

beforeEach(() => {
  mocks.start.mockClear()
  mocks.hostInstalled = false
  mocks.isWebClient = false
  mocks.installedListener = null
  resetLocalStructuredChatsForTests()
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      app: {
        hasStructuredAgentSessionHost: vi.fn(async () => mocks.hostInstalled),
        onStructuredAgentSessionHostInstalled: vi.fn((listener: () => void) => {
          mocks.installedListener = listener
          return () => undefined
        })
      }
    }
  })
  useAppStore.setState({ workspaceSessionReady: true, terminalStartupRestorationReady: true })
})

afterEach(() => {
  cleanup()
  resetLocalStructuredChatsForTests()
  useAppStore.setState(useAppStore.getInitialState(), true)
})

describe("this machine's structured chat mirror", () => {
  it('holds no session-tabs subscription for a machine that never held a chat', async () => {
    setStructuredChat(false)

    await mountSync()

    expect(mocks.start).not.toHaveBeenCalled()
  })

  // The setting picks what new agents open as; chats that already exist keep showing.
  it('mirrors the chats this machine holds with the setting off', async () => {
    setStructuredChat(false)
    mocks.hostInstalled = true

    await mountSync()

    expect(mocks.start).toHaveBeenCalledOnce()
  })

  it('starts when a paired client creates the first chat here, without a restart', async () => {
    setStructuredChat(false)
    await mountSync()
    expect(mocks.start).not.toHaveBeenCalled()

    act(() => mocks.installedListener?.())

    expect(mocks.start).toHaveBeenCalledOnce()
  })

  it('stays mirrored when the setting is turned off over chats this machine holds', async () => {
    setStructuredChat(true)
    mocks.hostInstalled = true
    await mountSync()

    act(() => setStructuredChat(false))

    expect(mocks.start).toHaveBeenCalledOnce()
  })

  it('never runs in the browser client, which has no runtime of its own', async () => {
    mocks.isWebClient = true
    setStructuredChat(true)
    mocks.hostInstalled = true

    await mountSync()

    expect(mocks.start).not.toHaveBeenCalled()
  })
})
