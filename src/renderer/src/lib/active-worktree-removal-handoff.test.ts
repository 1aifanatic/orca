import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'
import type { Worktree } from '../../../shared/worktree/types'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import {
  createTestStore,
  mockApi,
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

// Stands in for the real activation: selecting the row is what the hand-off is responsible for.
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
import { installActiveWorktreeRemovalHandoff } from './active-worktree-removal-handoff'

const flushMicrotasks = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

function row(name: string, overrides: Partial<Worktree> = {}): Worktree {
  return makeWorktree({
    id: `repo1::/path/${name}`,
    repoId: 'repo1',
    path: `/path/${name}`,
    displayName: name,
    ...overrides
  })
}

const main = row('main', { isMainWorktree: true })
const older = row('older')
const recent = row('recent')
const viewed = row('viewed')

function seed(rows: Worktree[], state: Partial<AppState> = {}): ReturnType<typeof createTestStore> {
  const store = createTestStore()
  holder.store = store
  store.setState({
    worktreesByRepo: { repo1: rows },
    activeView: 'terminal',
    activePendingCreationId: null,
    activeWorktreeId: viewed.id,
    lastVisitedAtByWorktreeId: { [older.id]: 100, [recent.id]: 200 },
    deleteStateByWorktreeId: {},
    ...state
  })
  return store
}

/** The shape of every removal writer: the row leaves and the selection empties in one update. */
function dropRow(store: ReturnType<typeof createTestStore>, worktreeId: string): void {
  store.setState((s) => ({
    worktreesByRepo: { repo1: s.worktreesByRepo.repo1.filter((w) => w.id !== worktreeId) },
    activeWorktreeId: s.activeWorktreeId === worktreeId ? null : s.activeWorktreeId
  }))
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

function install(): void {
  uninstall = installActiveWorktreeRemovalHandoff()
}

describe('active workspace removal hand-off, through the real removal writers', () => {
  it('moves to the last-visited sibling when a refresh drops the workspace (removed outside Orca)', async () => {
    const store = seed([main, older, recent, viewed])
    install()
    mockApi.worktrees.list.mockResolvedValue([main, older, recent])

    await store.getState().fetchWorktrees('repo1')
    await flushMicrotasks()

    expect(activateAndRevealWorktree).toHaveBeenCalledWith(recent.id, { revealInSidebar: false })
    expect(store.getState().activeWorktreeId).toBe(recent.id)
  })

  it('moves on once a delete that failed after git dropped the worktree is confirmed by refresh', async () => {
    const store = seed([main, older, recent, viewed])
    install()
    mockApi.worktrees.remove.mockRejectedValueOnce(new Error('EPERM: operation not permitted'))

    const result = await store.getState().removeWorktree({ id: viewed.id, executionHostId: null })
    await flushMicrotasks()

    // The failed delete leaves the user where they were.
    expect(result.ok).toBe(false)
    expect(store.getState().activeWorktreeId).toBe(viewed.id)
    expect(activateAndRevealWorktree).not.toHaveBeenCalled()

    mockApi.worktrees.list.mockResolvedValue([main, older, recent])
    await store.getState().fetchWorktrees('repo1')
    await flushMicrotasks()

    expect(store.getState().activeWorktreeId).toBe(recent.id)
  })

  it('moves to the last-visited sibling after a successful in-Orca delete', async () => {
    const store = seed([main, older, recent, viewed])
    install()

    const result = await store.getState().removeWorktree({ id: viewed.id, executionHostId: null })
    await flushMicrotasks()

    expect(result.ok).toBe(true)
    expect(activateAndRevealWorktree).toHaveBeenCalledTimes(1)
    expect(store.getState().activeWorktreeId).toBe(recent.id)
  })

  it('keeps the workspace the user navigated to while the delete was running', async () => {
    const store = seed([main, older, recent, viewed])
    install()
    let finishRemoval: () => void = () => {}
    mockApi.worktrees.remove.mockImplementationOnce(
      () => new Promise<void>((resolve) => (finishRemoval = resolve))
    )

    const removal = store.getState().removeWorktree({ id: viewed.id, executionHostId: null })
    await flushMicrotasks()
    store.setState({ activeWorktreeId: older.id })
    finishRemoval()
    await removal
    await flushMicrotasks()

    expect(activateAndRevealWorktree).not.toHaveBeenCalled()
    expect(store.getState().activeWorktreeId).toBe(older.id)
  })

  it('falls back to the main workspace when the removed one was the last', async () => {
    const store = seed([main, viewed])
    install()
    mockApi.worktrees.list.mockResolvedValue([main])

    await store.getState().fetchWorktrees('repo1')
    await flushMicrotasks()

    expect(store.getState().activeWorktreeId).toBe(main.id)
  })
})

describe('successor choice during a batch delete', () => {
  it('skips a row a cleanup batch queued under its local host key', async () => {
    // Cleanup queues local rows as `local|<id>` while the row itself carries no host.
    const store = seed([main, older, recent, viewed], {
      deleteStateByWorktreeId: {
        [`local|${recent.id}`]: {
          isDeleting: true,
          phase: 'queued',
          executionHostId: 'local',
          error: null,
          canForceDelete: false,
          forceDeleteReason: null
        }
      }
    })
    install()

    dropRow(store, viewed.id)
    await flushMicrotasks()

    expect(store.getState().activeWorktreeId).toBe(older.id)
  })

  it('skips every row the sidebar batch marked as deleting, landing on main', async () => {
    const store = seed([main, older, recent, viewed])
    store.getState().markWorktreesDeleting([older.id, recent.id, viewed.id])
    install()

    dropRow(store, viewed.id)
    await flushMicrotasks()
    // The next batch row going does not move focus again: the user is on main now.
    dropRow(store, recent.id)
    await flushMicrotasks()

    expect(activateAndRevealWorktree).toHaveBeenCalledTimes(1)
    expect(store.getState().activeWorktreeId).toBe(main.id)
  })
})

describe('when the hand-off must not move the user', () => {
  it('lets a navigation in the same tick as the removal win', async () => {
    const store = seed([main, older, recent, viewed])
    install()

    dropRow(store, viewed.id)
    store.setState({ activeWorktreeId: older.id })
    await flushMicrotasks()

    expect(activateAndRevealWorktree).not.toHaveBeenCalled()
    expect(store.getState().activeWorktreeId).toBe(older.id)
  })

  it('does not move focus when a background workspace is removed', async () => {
    const store = seed([main, older, recent, viewed], { activeWorktreeId: older.id })
    install()

    dropRow(store, viewed.id)
    await flushMicrotasks()

    expect(activateAndRevealWorktree).not.toHaveBeenCalled()
  })

  it('does not move focus when a folder workspace is active', async () => {
    const store = seed([main, viewed], { activeWorktreeId: 'folder:abc' })
    install()

    dropRow(store, viewed.id)
    await flushMicrotasks()

    expect(activateAndRevealWorktree).not.toHaveBeenCalled()
  })

  it('does not act when the selection empties without the row leaving', async () => {
    const store = seed([main, older, viewed])
    install()

    // Closing the last tab lands on the empty screen on purpose.
    store.setState({ activeWorktreeId: null })
    dropRow(store, viewed.id)
    await flushMicrotasks()

    expect(activateAndRevealWorktree).not.toHaveBeenCalled()
  })

  it('does not steal focus from a non-terminal view', async () => {
    // Top-level views can retain the last terminal workspace id without showing it.
    const store = seed([main, viewed], { activeView: 'space' })
    install()

    dropRow(store, viewed.id)
    await flushMicrotasks()

    expect(activateAndRevealWorktree).not.toHaveBeenCalled()
  })

  it('does not steal focus from the pending-creation panel', async () => {
    const store = seed([main, viewed], { activePendingCreationId: 'creation-1' })
    install()

    dropRow(store, viewed.id)
    await flushMicrotasks()

    expect(activateAndRevealWorktree).not.toHaveBeenCalled()
  })

  it('does not act when the user leaves the terminal view before the hand-off runs', async () => {
    const store = seed([main, viewed])
    install()

    dropRow(store, viewed.id)
    store.setState({ activeView: 'settings' })
    await flushMicrotasks()

    expect(activateAndRevealWorktree).not.toHaveBeenCalled()
  })

  it('does not focus a sibling hosted on a torn-down runtime-owned SSH target', async () => {
    // That target dies with the workspace; re-focusing its main would spawn a terminal that never starts.
    const host = 'ssh:runtime-ssh-orca-1' as const
    const store = seed([
      { ...main, hostId: host },
      { ...viewed, hostId: host }
    ])
    install()

    dropRow(store, viewed.id)
    await flushMicrotasks()

    expect(activateAndRevealWorktree).not.toHaveBeenCalled()
  })

  it('stays within the removed workspace project', async () => {
    const otherProject = makeWorktree({ id: 'repo2::/path/x', repoId: 'repo2', path: '/path/x' })
    const store = seed([main, viewed])
    store.setState((s) => ({ worktreesByRepo: { ...s.worktreesByRepo, repo2: [otherProject] } }))
    install()

    dropRow(store, viewed.id)
    await flushMicrotasks()

    expect(store.getState().activeWorktreeId).toBe(main.id)
  })

  it('activates an SSH sibling on its own host', async () => {
    const host = 'ssh:alpha' as const
    const store = seed([
      { ...main, hostId: host },
      { ...recent, hostId: host },
      { ...viewed, hostId: host }
    ])
    install()

    dropRow(store, viewed.id)
    await flushMicrotasks()

    expect(activateAndRevealWorktree).toHaveBeenCalledWith(recent.id, {
      revealInSidebar: false,
      executionHostId: host
    })
  })
})
