import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import { createTestStore, makeWorktree, seedStore } from './store-test-helpers'
import { createStoreCascadesMockApi } from './store-cascades-test-harness'

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
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))

vi.mock('@/components/terminal-pane/pty-dispatcher', () => ({
  restorePtyDataHandlersAfterFailedShutdown: vi.fn(),
  unregisterPtyDataHandlers: vi.fn(() => [])
}))

vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
})

import { installActiveWorktreeRemovalHandoff } from '@/lib/active-worktree-removal-handoff'

const mockApi = createStoreCascadesMockApi()

const MAIN = 'repo1::/path/main'
const SIBLING = 'repo1::/path/sibling'
const VIEWED = 'repo1::/path/viewed'

function storeViewingWorkspaceWithOneTerminal(): {
  store: ReturnType<typeof createTestStore>
  tabId: string
} {
  const store = createTestStore()
  holder.store = store
  seedStore(store, {
    worktreesByRepo: {
      repo1: [
        makeWorktree({ id: MAIN, repoId: 'repo1', path: '/path/main', isMainWorktree: true }),
        makeWorktree({ id: SIBLING, repoId: 'repo1', path: '/path/sibling' }),
        makeWorktree({ id: VIEWED, repoId: 'repo1', path: '/path/viewed' })
      ]
    },
    activeView: 'terminal',
    activeWorktreeId: VIEWED,
    lastVisitedAtByWorktreeId: { [SIBLING]: 100 }
  })
  const tabId = store.getState().createTab(VIEWED).id
  return { store, tabId }
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

let uninstall: (() => void) | null = null

beforeEach(() => {
  vi.clearAllMocks()
  mockApi.worktrees.remove.mockResolvedValue(undefined)
})

afterEach(() => {
  uninstall?.()
  uninstall = null
})

describe('closing the last tab of the viewed workspace', () => {
  it('still lands on the empty screen when the workspace is not being deleted', () => {
    const { store, tabId } = storeViewingWorkspaceWithOneTerminal()

    store.getState().closeTab(tabId)

    expect(store.getState().activeWorktreeId).toBeNull()
  })

  it('keeps the selection while the workspace is being deleted', () => {
    const { store, tabId } = storeViewingWorkspaceWithOneTerminal()
    store.getState().markWorktreesDeleting([VIEWED])

    store.getState().closeTab(tabId)

    expect(store.getState().activeWorktreeId).toBe(VIEWED)
  })

  it('keeps the selection while a cleanup batch has the workspace queued under its host key', () => {
    const { store, tabId } = storeViewingWorkspaceWithOneTerminal()
    store.getState().markWorktreesQueuedForDeletion([{ id: VIEWED, hostId: 'local' }])

    store.getState().closeTab(tabId)

    expect(store.getState().activeWorktreeId).toBe(VIEWED)
  })
})

describe('in-Orca delete of the viewed workspace', () => {
  it('moves to the sibling when the delete ends the workspace shells before dropping the row', async () => {
    const { store, tabId } = storeViewingWorkspaceWithOneTerminal()
    uninstall = installActiveWorktreeRemovalHandoff()
    // The backend stops the workspace's shells before git runs; the pane closes its tab on exit.
    mockApi.worktrees.remove.mockImplementationOnce(async () => {
      store.getState().closeTab(tabId)
    })

    const result = await store.getState().removeWorktree({ id: VIEWED, executionHostId: null })
    await flush()

    expect(result.ok).toBe(true)
    expect(store.getState().activeWorktreeId).toBe(SIBLING)
  })
})
