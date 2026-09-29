import { describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import { createTestStore, makeWorktree, seedStore } from './store-test-helpers'
import { createStoreCascadesMockApi } from './store-cascades-test-harness'

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

createStoreCascadesMockApi()

const WT = 'repo1::/path/wt1'

function storeWithOnlyBrowserTab(): ReturnType<typeof createTestStore> {
  const store = createTestStore()
  seedStore(store, {
    worktreesByRepo: { repo1: [makeWorktree({ id: WT, repoId: 'repo1', path: '/path/wt1' })] },
    activeWorktreeId: WT,
    activeTabType: 'terminal'
  })
  store.getState().createBrowserTab(WT, 'https://example.test/', { activate: true })
  return store
}

describe('shutdownWorktreeBrowsers selection', () => {
  it('keeps the workspace selected when the caller owns the selection change', async () => {
    const store = storeWithOnlyBrowserTab()

    await store.getState().shutdownWorktreeBrowsers(WT, { preserveWorktreeSelection: true })

    expect(store.getState().browserTabsByWorktree[WT]).toBeUndefined()
    expect(store.getState().activeWorktreeId).toBe(WT)
  })

  it('still lands on the empty screen when the last tab goes without that request', async () => {
    const store = storeWithOnlyBrowserTab()

    await store.getState().shutdownWorktreeBrowsers(WT)

    expect(store.getState().activeWorktreeId).toBeNull()
  })
})
