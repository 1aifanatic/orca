// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitStatusEntry } from '../../../../../../shared/git-status-types'

const mocks = vi.hoisted(() => ({ bulkStage: vi.fn() }))

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('@/lib/connection-context', () => ({ getConnectionId: () => 'ssh-1' }))
vi.mock('@/runtime/runtime-git-client', () => ({
  bulkStageRuntimeGitPaths: (...args: unknown[]) => mocks.bulkStage(...args),
  bulkUnstageRuntimeGitPaths: vi.fn()
}))

import { useSourceControlBulkActions } from './use-bulk-actions'
import type { SourceControlEntryGroups } from '../listing/section-order'

function entry(path: string, area: GitStatusEntry['area']): GitStatusEntry {
  return { path, status: area === 'untracked' ? 'untracked' : 'modified', area }
}

function renderBulkActions(grouped: SourceControlEntryGroups, isStatusTruncated: boolean) {
  return renderHook(() =>
    useSourceControlBulkActions({
      selectedKeys: new Set(),
      flatEntriesByKey: new Map(),
      activeRepoSettings: null,
      activeWorktreeId: 'wt-1',
      worktreePath: '/repo',
      grouped,
      isStatusTruncated,
      clearSelection: () => {},
      refreshActiveGitStatusAfterMutation: async () => {}
    })
  )
}

const GROUPED: SourceControlEntryGroups = {
  staged: [],
  unstaged: [entry('a.ts', 'unstaged')],
  untracked: [entry('new.ts', 'untracked')]
}

beforeEach(() => {
  mocks.bulkStage.mockReset()
  mocks.bulkStage.mockResolvedValue(undefined)
})

describe('Stage All on a capped status listing', () => {
  it('stages the listed paths when the listing is complete', async () => {
    const { result } = renderBulkActions(GROUPED, false)
    await act(() => result.current.handleStageAllPrimary())

    expect(mocks.bulkStage).toHaveBeenCalledWith(
      expect.objectContaining({ worktreePath: '/repo', connectionId: 'ssh-1' }),
      ['a.ts', 'new.ts'],
      undefined
    )
  })

  it('asks the host to stage everything when the listing hit its cap', async () => {
    const { result } = renderBulkActions(GROUPED, true)
    await act(() => result.current.handleStageAllPrimary())

    expect(mocks.bulkStage).toHaveBeenCalledWith(
      expect.objectContaining({ worktreePath: '/repo' }),
      ['a.ts', 'new.ts'],
      'all'
    )
  })

  it('still reaches the host when every listed row is already staged', async () => {
    const { result } = renderBulkActions(
      { staged: [entry('a.ts', 'staged')], unstaged: [], untracked: [] },
      true
    )
    await act(() => result.current.handleStageAllPrimary())

    expect(mocks.bulkStage).toHaveBeenCalledWith(expect.anything(), [], 'all')
  })

  it('stages tracked changes on the host for the capped Changes section only', async () => {
    const { result } = renderBulkActions(GROUPED, true)
    await act(() => result.current.handleStageSectionPaths('unstaged', ['a.ts']))
    await act(() => result.current.handleStageSectionPaths('conflicts', ['c.ts']))

    expect(mocks.bulkStage).toHaveBeenNthCalledWith(1, expect.anything(), ['a.ts'], 'tracked')
    expect(mocks.bulkStage).toHaveBeenNthCalledWith(2, expect.anything(), ['c.ts'], undefined)
  })
})
