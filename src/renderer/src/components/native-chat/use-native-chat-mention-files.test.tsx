// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import {
  flushEffects,
  listRuntimeFilesMock,
  searchRuntimeFilePathsMock,
  seedRemoteWorktree
} from '../quick-open-file-list-test-harness'
import { useAppStore } from '@/store'
import { terminalTabFixture } from './native-chat-workspace-test-fixtures'
import type { NativeChatTabScope } from './native-chat-tab-scope'
import { useNativeChatMentionFiles } from './use-native-chat-mention-files'

vi.mock('@/runtime/runtime-file-client', async () => {
  const mocks = await import('../__mocks__/quick-open-runtime-file-client')
  return {
    listRuntimeFiles: mocks.listRuntimeFilesMock,
    cancelRuntimeFileList: mocks.cancelRuntimeFileListMock,
    searchRuntimeFilePaths: mocks.searchRuntimeFilePathsMock
  }
})

describe('useNativeChatMentionFiles', () => {
  it('lists nothing and asks the host for nothing while no token is open', async () => {
    seedRemoteWorktree()
    const { result, unmount } = renderHook(() =>
      useNativeChatMentionFiles({
        query: null,
        scope: { kind: 'structured', worktreeId: 'wt-remote', tabId: 'tab-1' }
      })
    )
    await flushEffects()
    expect(result.current.files).toEqual([])
    expect(listRuntimeFilesMock).not.toHaveBeenCalled()
    unmount()
  })

  const BRIDGE: NativeChatTabScope = { kind: 'bridge', worktreeId: 'wt-remote', tabId: 'tab-1' }

  it('lists an open token against the supplied workspace while the tab is a member', async () => {
    seedRemoteWorktree()
    useAppStore.setState({
      tabsByWorktree: { 'wt-remote': [terminalTabFixture('tab-1', 'wt-remote')] }
    })
    vi.useFakeTimers()
    try {
      const { unmount } = renderHook(() =>
        useNativeChatMentionFiles({ query: 'pkg', scope: BRIDGE })
      )
      await flushEffects()
      // Past the remote query debounce.
      await act(async () => vi.advanceTimersByTimeAsync(120))
      await flushEffects()
      expect(searchRuntimeFilePathsMock).toHaveBeenCalledWith(
        expect.objectContaining({ worktreeId: 'wt-remote', worktreePath: '/srv/remote' }),
        expect.anything()
      )
      unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  it('lists nothing for an open token once the tab left its workspace', async () => {
    seedRemoteWorktree()
    // Moved, not closed: neither its new workspace nor the active one is listed instead.
    useAppStore.setState({
      activeWorktreeId: 'wt-remote',
      tabsByWorktree: { 'wt-remote': [], 'wt-other': [terminalTabFixture('tab-1', 'wt-other')] }
    })
    vi.useFakeTimers()
    try {
      const { result, unmount } = renderHook(() =>
        useNativeChatMentionFiles({ query: 'pkg', scope: BRIDGE })
      )
      await flushEffects()
      await act(async () => vi.advanceTimersByTimeAsync(120))
      await flushEffects()
      expect(result.current.files).toEqual([])
      expect(searchRuntimeFilePathsMock).not.toHaveBeenCalled()
      expect(listRuntimeFilesMock).not.toHaveBeenCalled()
      unmount()
    } finally {
      vi.useRealTimers()
    }
  })
})
