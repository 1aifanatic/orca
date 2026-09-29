import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Worktree } from '../../../../shared/worktree/types'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import {
  createTestStore,
  resetRemoteRuntimeMocks,
  resetWorktreeSliceModuleMemory
} from '@/store/slices/worktrees-slice-test-harness'

const holder = vi.hoisted((): { store: ReturnType<typeof createTestStore> | null } => ({
  store: null
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => holder.store!.getState(),
    setState: (...args: Parameters<NonNullable<typeof holder.store>['setState']>) =>
      holder.store!.setState(...args),
    subscribe: (...args: Parameters<NonNullable<typeof holder.store>['subscribe']>) =>
      holder.store!.subscribe(...args)
  }
}))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: vi.fn((worktreeId: string) => {
    holder.store!.setState({ activeWorktreeId: worktreeId })
    return { primaryTabId: null }
  })
}))

vi.mock('sonner', () => ({
  toast: { warning: vi.fn(), info: vi.fn(), success: vi.fn(), error: vi.fn(), dismiss: vi.fn() }
}))

vi.mock('@/components/worktree-base-fallback-notice', () => ({
  requestWorktreeBaseFallbackNotice: vi.fn()
}))

import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { installActiveWorktreeRemovalHandoff } from '@/lib/active-worktree-removal-handoff'
import { clearSshHostWorkspaces } from './ssh-host-remove-workspaces'

const host = 'ssh:alpha' as const

function row(name: string, overrides: Partial<Worktree> = {}): Worktree {
  return makeWorktree({
    id: `repo1::/path/${name}`,
    repoId: 'repo1',
    path: `/path/${name}`,
    displayName: name,
    hostId: host,
    ...overrides
  })
}

let uninstall: (() => void) | null = null

beforeEach(() => {
  resetWorktreeSliceModuleMemory()
  vi.clearAllMocks()
  resetRemoteRuntimeMocks()
})

afterEach(() => {
  uninstall?.()
  uninstall = null
})

const main = row('main', { isMainWorktree: true })
const older = row('older')
const recent = row('recent')
const viewed = row('viewed')

function seed(): ReturnType<typeof createTestStore> {
  const store = createTestStore()
  holder.store = store
  store.setState({
    worktreesByRepo: { repo1: [main, older, recent, viewed] },
    activeView: 'terminal',
    activePendingCreationId: null,
    activeWorktreeId: viewed.id,
    activeWorkspaceExecutionHostId: host,
    lastVisitedAtByWorktreeId: { [older.id]: 100, [recent.id]: 200 },
    deleteStateByWorktreeId: {}
  })
  uninstall = installActiveWorktreeRemovalHandoff()
  return store
}

const resolution = {
  targetId: 'alpha',
  workspaceWorktreeIds: [viewed.id, older.id, recent.id],
  hostRepoIds: ['repo1'],
  workspaceCount: 4,
  isConnected: false
}

describe('clearSshHostWorkspaces', () => {
  it('never hands focus to a row the host removal is about to take', async () => {
    const store = seed()
    // Keep the main row: this test is about the hand-off, not project removal.
    store.setState({ removeProject: vi.fn().mockResolvedValue(undefined) })

    await clearSshHostWorkspaces(resolution, 'forget-local')
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(activateAndRevealWorktree).not.toHaveBeenCalled()
    expect(store.getState().activeWorktreeId).toBeNull()
  })

  it('releases the queued marker of a row the removal did not take', async () => {
    const store = seed()
    store.setState({ removeProject: vi.fn().mockResolvedValue(undefined) })

    await clearSshHostWorkspaces(resolution, 'forget-local')

    // The kept main row must not sit on a "queued" spinner once the removal is over.
    expect(store.getState().deleteStateByWorktreeId).toEqual({})
    expect(store.getState().worktreesByRepo.repo1.map((w) => w.id)).toEqual([main.id])
  })
})
