// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ start: vi.fn(async () => undefined) }))

vi.mock('./local-structured-session-tabs-sync/subscription', () => ({
  startLocalStructuredSessionTabsSync: mocks.start
}))

import { useAppStore } from '../store'
import { useLocalStructuredSessionTabsSync } from './local-structured-session-tabs-sync'

function setStructuredChat(enabled: boolean): void {
  useAppStore.setState({
    settings: { ...useAppStore.getState().settings!, experimentalStructuredNativeChat: enabled }
  })
}

beforeEach(() => {
  mocks.start.mockClear()
  useAppStore.setState({
    workspaceSessionReady: true,
    terminalStartupRestorationReady: true
  })
})

afterEach(() => {
  cleanup()
  useAppStore.setState(useAppStore.getInitialState(), true)
})

// The setting picks what new agents open as; chats that already exist keep showing.
describe("this machine's structured chats", () => {
  it('are mirrored with the structured chat setting off', () => {
    setStructuredChat(false)

    renderHook(() => useLocalStructuredSessionTabsSync())

    expect(mocks.start).toHaveBeenCalledOnce()
  })

  it('stay mirrored when the setting is turned off', () => {
    setStructuredChat(true)
    renderHook(() => useLocalStructuredSessionTabsSync())

    act(() => setStructuredChat(false))

    expect(mocks.start).toHaveBeenCalledOnce()
  })
})
