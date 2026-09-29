import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { createTestStore, makeWorktree, seedStore } from './store-test-helpers'
import { createStoreCascadesMockApi } from './store-cascades-test-harness'
import { clearRuntimeCompatibilityCacheForTests } from '../../runtime/runtime-rpc-client'
import {
  _resetBackgroundWorktreeRemovalsForTests,
  noteBackgroundWorktreeRemovalEventGap,
  setBackgroundWorktreeRemovalRowsLookup,
  settleBackgroundWorktreeRemoval
} from './worktrees/teardown/background-worktree-removal'
import {
  _resetBackgroundWorktreeRemovalBridgeForTests,
  applyBackgroundWorktreeRemovalOutcome,
  reconcileHostWorktreeRemovals
} from '../../hooks/ipc-events/background-worktree-removal-bridge'
import { getWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))
vi.mock('@/components/terminal-pane/pty-dispatcher', () => ({
  restorePtyDataHandlersAfterFailedShutdown: vi.fn(),
  unregisterPtyDataHandlers: vi.fn(() => [])
}))

const mockApi = createStoreCascadesMockApi()
const worktreeId = 'repo1::/path/wt1'
const hostKey = getWorktreeHostIdentity({ id: worktreeId, hostId: 'local' })

function seedRow(
  store: ReturnType<typeof createTestStore>,
  overrides: { removing?: true } = {}
): void {
  seedStore(store, {
    worktreesByRepo: {
      repo1: [
        makeWorktree({
          id: worktreeId,
          repoId: 'repo1',
          path: '/path/wt1',
          hostId: 'local',
          ...overrides
        })
      ]
    }
  })
}

function deleteState(store: ReturnType<typeof createTestStore>) {
  const states = store.getState().deleteStateByWorktreeId
  return states[hostKey] ?? states[worktreeId]
}

describe('removing a worktree the host deletes in the background', () => {
  let store: ReturnType<typeof createTestStore>

  beforeEach(() => {
    vi.clearAllMocks()
    clearRuntimeCompatibilityCacheForTests()
    store = createTestStore()
    setBackgroundWorktreeRemovalRowsLookup((id) =>
      (store.getState().worktreesByRepo.repo1 ?? []).filter((row) => row.id === id)
    )
    mockApi.worktrees.remove.mockResolvedValue({
      removing: true,
      catalogVersion: { epoch: 'e', sequence: 1 }
    })
  })

  afterEach(() => {
    _resetBackgroundWorktreeRemovalsForTests()
    _resetBackgroundWorktreeRemovalBridgeForTests()
  })

  it('keeps the card Deleting until the host reports the delete finished', async () => {
    seedRow(store)
    const removal = store.getState().removeWorktree({ id: worktreeId, executionHostId: null })
    await vi.waitFor(() => expect(mockApi.worktrees.remove).toHaveBeenCalled())
    await Promise.resolve()

    expect(deleteState(store)?.isDeleting).toBe(true)
    expect(store.getState().worktreesByRepo.repo1?.map((row) => row.id)).toEqual([worktreeId])

    settleBackgroundWorktreeRemoval('local', {
      worktreeId,
      status: 'removed',
      preservedBranch: { branchName: 'feature', head: 'abc123' }
    })

    await expect(removal).resolves.toMatchObject({
      ok: true,
      preservedBranch: { branchName: 'feature', head: 'abc123' }
    })
    expect(store.getState().worktreesByRepo.repo1).toEqual([])
    // The preserved-branch notice reaches the user through the same path an inline delete used.
    expect(toast.warning).toHaveBeenCalledTimes(1)
  })

  it('shows the host error on the card when the delete fails after acceptance', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    seedRow(store)
    const removal = store.getState().removeWorktree({ id: worktreeId, executionHostId: null })
    await vi.waitFor(() => expect(mockApi.worktrees.remove).toHaveBeenCalled())
    await Promise.resolve()

    settleBackgroundWorktreeRemoval('local', {
      worktreeId,
      status: 'failed',
      error: 'Failed to delete worktree at /path/wt1. Permission denied'
    })

    await expect(removal).resolves.toEqual({
      ok: false,
      error: 'Failed to delete worktree at /path/wt1. Permission denied'
    })
    expect(deleteState(store)).toMatchObject({
      isDeleting: false,
      error: 'Failed to delete worktree at /path/wt1. Permission denied'
    })
    expect(store.getState().worktreesByRepo.repo1?.map((row) => row.id)).toEqual([worktreeId])
  })

  it('waits for the outcome when Git unlists the row before the host finishes the removal', async () => {
    seedRow(store)
    const removal = store.getState().removeWorktree({ id: worktreeId, executionHostId: null })
    await vi.waitFor(() => expect(mockApi.worktrees.remove).toHaveBeenCalled())
    await Promise.resolve()

    // The worktree-directory watcher refetches as soon as Git drops the registration, while the
    // host is still deleting the branch.
    seedRow(store, { removing: true })
    reconcileHostWorktreeRemovals(store)
    seedStore(store, { worktreesByRepo: { repo1: [] } })
    reconcileHostWorktreeRemovals(store)
    expect(deleteState(store)?.isDeleting).toBe(true)

    settleBackgroundWorktreeRemoval('local', {
      worktreeId,
      status: 'removed',
      preservedBranch: { branchName: 'feature', head: 'abc123' }
    })
    await expect(removal).resolves.toMatchObject({
      ok: true,
      preservedBranch: { branchName: 'feature', head: 'abc123' }
    })
    expect(toast.warning).toHaveBeenCalledTimes(1)
  })

  it('finishes from the listing when the event stream had a gap', async () => {
    seedRow(store)
    const removal = store.getState().removeWorktree({ id: worktreeId, executionHostId: null })
    await vi.waitFor(() => expect(mockApi.worktrees.remove).toHaveBeenCalled())
    await Promise.resolve()

    seedRow(store, { removing: true })
    reconcileHostWorktreeRemovals(store)
    seedStore(store, { worktreesByRepo: { repo1: [] } })
    reconcileHostWorktreeRemovals(store)
    noteBackgroundWorktreeRemovalEventGap('local')

    await expect(removal).resolves.toEqual({ ok: true })
  })

  it('reports a delete the host dropped once a gap shows the row back unmarked', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    seedRow(store)
    const removal = store.getState().removeWorktree({ id: worktreeId, executionHostId: null })
    await vi.waitFor(() => expect(mockApi.worktrees.remove).toHaveBeenCalled())
    await Promise.resolve()

    noteBackgroundWorktreeRemovalEventGap('local')
    seedRow(store, { removing: true })
    reconcileHostWorktreeRemovals(store)
    seedRow(store)
    reconcileHostWorktreeRemovals(store)

    await expect(removal).resolves.toMatchObject({ ok: false })
  })

  it('shows Deleting on a client that did not start the delete, from the host marker alone', () => {
    seedRow(store, { removing: true })
    reconcileHostWorktreeRemovals(store)
    expect(deleteState(store)).toMatchObject({ isDeleting: true, phase: 'deleting' })

    // Git finished or the host dropped the marker: the card returns to normal.
    seedRow(store)
    reconcileHostWorktreeRemovals(store)
    expect(deleteState(store)).toBeUndefined()
  })

  it('puts a failure the host publishes on a card it marked Deleting', () => {
    seedRow(store, { removing: true })
    reconcileHostWorktreeRemovals(store)

    applyBackgroundWorktreeRemovalOutcome(
      'local',
      { worktreeId, status: 'failed', error: 'Permission denied' },
      store
    )

    expect(deleteState(store)).toMatchObject({ isDeleting: false, error: 'Permission denied' })
  })

  it('does not fail a retry with the failure of an earlier delete it did not wait on', async () => {
    seedRow(store, { removing: true })
    reconcileHostWorktreeRemovals(store)
    applyBackgroundWorktreeRemovalOutcome(
      'local',
      { worktreeId, status: 'failed', error: 'Permission denied' },
      store
    )
    seedRow(store)
    reconcileHostWorktreeRemovals(store)

    const retry = store.getState().removeWorktree({ id: worktreeId, executionHostId: 'local' })
    await vi.waitFor(() => expect(mockApi.worktrees.remove).toHaveBeenCalled())
    await Promise.resolve()
    await Promise.resolve()
    expect(deleteState(store)).toMatchObject({ isDeleting: true, error: null })

    settleBackgroundWorktreeRemoval('local', { worktreeId, status: 'removed' })
    await expect(retry).resolves.toEqual({ ok: true })
  })

  it('leaves a delete this renderer started to that flow', () => {
    seedRow(store, { removing: true })
    store.getState().markWorktreesDeleting([{ id: worktreeId, hostId: 'local' }])
    reconcileHostWorktreeRemovals(store)
    seedRow(store)
    reconcileHostWorktreeRemovals(store)
    expect(deleteState(store)?.isDeleting).toBe(true)
  })
})
