// @vitest-environment happy-dom

import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatTabScope } from './native-chat-tab-scope'

const mocks = vi.hoisted(() => ({
  resolveContext: vi.fn((_scope: unknown) => null)
}))

vi.mock('./native-chat-session-option-discovery', () => ({
  resolveNativeChatModelDiscoveryContext: (scope: unknown) => mocks.resolveContext(scope),
  discoverNativeChatCatalogModels: async () => null
}))

const storeState = { settings: {}, agentStatusByPaneKey: {} }
vi.mock('../../store', () => ({
  useAppStore: Object.assign(
    (selector: (state: typeof storeState) => unknown) => selector(storeState),
    { getState: () => storeState }
  )
}))

import { useNativeChatSessionOptions } from './use-native-chat-session-options'

function useOptions(scope: NativeChatTabScope, targetPtyId: string | null) {
  return useNativeChatSessionOptions({
    agent: 'codex',
    scope,
    targetPtyId,
    dispatchCommand: vi.fn()
  })
}

describe('useNativeChatSessionOptions workspace lookup', () => {
  beforeEach(() => {
    mocks.resolveContext.mockClear()
  })

  it('never resolves terminal discovery for a structured chat, even when a terminal id collides', () => {
    renderHook(() => useOptions({ kind: 'structured', worktreeId: 'wt-1', tabId: 'tab-1' }, null))
    expect(mocks.resolveContext).not.toHaveBeenCalled()
  })

  it('keeps bridge discovery while a bridge PTY is briefly absent', () => {
    renderHook(() => useOptions({ kind: 'bridge', worktreeId: 'wt-1', tabId: 'tab-1' }, null))
    expect(mocks.resolveContext).toHaveBeenCalledExactlyOnceWith({
      kind: 'bridge',
      worktreeId: 'wt-1',
      tabId: 'tab-1'
    })
  })

  it('re-resolves when the same terminal id is rebound to another workspace', () => {
    const { rerender } = renderHook(
      ({ worktreeId }) => useOptions({ kind: 'bridge', worktreeId, tabId: 'tab-1' }, 'pty-1'),
      { initialProps: { worktreeId: 'wt-1' } }
    )
    rerender({ worktreeId: 'wt-1' })
    expect(mocks.resolveContext).toHaveBeenCalledTimes(1)

    rerender({ worktreeId: 'wt-2' })
    expect(mocks.resolveContext).toHaveBeenCalledTimes(2)
    expect(mocks.resolveContext).toHaveBeenLastCalledWith({
      kind: 'bridge',
      worktreeId: 'wt-2',
      tabId: 'tab-1'
    })
  })

  it('switches resolver policy on explicit mode, not on PTY presence', () => {
    const initialProps: { kind: NativeChatTabScope['kind'] } = { kind: 'structured' }
    const { rerender } = renderHook(
      ({ kind }) => useOptions({ kind, worktreeId: 'wt-1', tabId: 'tab-1' }, null),
      { initialProps }
    )
    expect(mocks.resolveContext).not.toHaveBeenCalled()
    rerender({ kind: 'bridge' })
    expect(mocks.resolveContext).toHaveBeenCalledOnce()
  })
})
