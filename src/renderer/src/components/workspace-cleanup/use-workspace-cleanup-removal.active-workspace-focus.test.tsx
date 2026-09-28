// @vitest-environment happy-dom

import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceCleanupRemoveResult } from '@/store/slices/workspace-cleanup'
import { getWorkspaceCleanupCandidateIdentity } from '../../../../shared/workspace-cleanup-host-identity'

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() }
}))
vi.mock('@/lib/worktree-activation', () => ({ activateAndRevealWorktree: vi.fn() }))

import { useAppStore } from '@/store'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { makeWorktree } from '@/store/slices/store-test-helpers'
import { makeCandidate } from './workspace-cleanup-presentation-fixtures'
import { useWorkspaceCleanupRemoval } from './use-workspace-cleanup-removal'

const REPO_ID = 'repo-1'
const initialState = useAppStore.getInitialState()

function worktreeId(name: string): string {
  return `${REPO_ID}::/repo/${name}`
}

function candidateFor(name: string) {
  return makeCandidate({
    worktreeId: worktreeId(name),
    displayName: name,
    branch: name,
    path: `/repo/${name}`
  })
}

// Mirrors the store: a removed row leaves the catalog, and deleting the active one clears focus.
function simulateRemoval(ids: readonly string[]): WorkspaceCleanupRemoveResult {
  const removed = new Set(ids)
  useAppStore.setState((state) => ({
    worktreesByRepo: {
      [REPO_ID]: (state.worktreesByRepo[REPO_ID] ?? []).filter((wt) => !removed.has(wt.id))
    },
    activeWorktreeId:
      state.activeWorktreeId && removed.has(state.activeWorktreeId) ? null : state.activeWorktreeId
  }))
  return {
    removedIds: [...ids],
    removedIdentities: ids.map((id) => getWorkspaceCleanupCandidateIdentity({ worktreeId: id })),
    failures: []
  }
}

function seed(activeName: string): void {
  Object.assign(window, { api: { workspaceCleanup: {} } })
  useAppStore.setState({
    activeView: 'terminal',
    activePendingCreationId: null,
    activeWorktreeId: worktreeId(activeName),
    worktreesByRepo: {
      [REPO_ID]: ['main', 'keep', 'active', 'longer-name', 'c'].map((name) =>
        makeWorktree({
          id: worktreeId(name),
          repoId: REPO_ID,
          path: `/repo/${name}`,
          isMainWorktree: name === 'main'
        })
      )
    },
    // The batch's own siblings are the most recent visits, so focus must skip rows the batch removes.
    lastVisitedAtByWorktreeId: {
      [worktreeId('keep')]: 100,
      [worktreeId('longer-name')]: 300,
      [worktreeId('c')]: 200
    },
    removeWorkspaceCleanupCandidates: vi.fn(async (ids: readonly string[]) => simulateRemoval(ids))
  })
}

function renderRemoval() {
  return renderHook(() =>
    useWorkspaceCleanupRemoval({ onDeselect: () => {}, closeModal: () => {} })
  )
}

type PendingRemoval = {
  ids: readonly string[]
  settle: (result: WorkspaceCleanupRemoveResult) => void
}

// Each row's removal stays pending until the test settles it, like a slow IPC delete.
function deferRemovals(): PendingRemoval[] {
  const pending: PendingRemoval[] = []
  useAppStore.setState({
    removeWorkspaceCleanupCandidates: vi.fn(
      (ids: readonly string[]) =>
        new Promise<WorkspaceCleanupRemoveResult>((resolve) => {
          pending.push({ ids, settle: resolve })
        })
    )
  })
  return pending
}

async function runBatch(names: readonly string[]): Promise<void> {
  const { result } = renderRemoval()
  act(() => result.current.openConfirmRemove(names.map(candidateFor)))
  act(() => result.current.confirmRemove())
  await waitFor(() => expect(result.current.removalInFlight).toBe(false))
}

async function settleNext(pending: PendingRemoval[], index: number): Promise<void> {
  await waitFor(() => expect(pending.length).toBeGreaterThan(index))
  await act(async () => pending[index].settle(simulateRemoval(pending[index].ids)))
}

async function settleAll(pending: PendingRemoval[], count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await settleNext(pending, index)
  }
}

function startBatch(names: readonly string[]) {
  const rendered = renderRemoval()
  act(() => rendered.result.current.openConfirmRemove(names.map(candidateFor)))
  act(() => rendered.result.current.confirmRemove())
  return rendered
}

const KEEP_FOCUS = [worktreeId('keep'), { revealInSidebar: false }] as const

describe('workspace cleanup removal of the active workspace', () => {
  beforeEach(() => {
    vi.mocked(activateAndRevealWorktree).mockReset()
    // Mirrors real activation so later reads see the new active workspace.
    vi.mocked(activateAndRevealWorktree).mockImplementation((id) => {
      useAppStore.setState({ activeWorktreeId: id })
      return false
    })
  })

  afterEach(() => {
    useAppStore.setState(initialState, true)
    Reflect.deleteProperty(window, 'api')
  })

  it('moves focus at confirm, before any row is removed, skipping every row in the batch', async () => {
    seed('active')
    const pending = deferRemovals()
    const { result } = startBatch(['c', 'active', 'longer-name'])

    // c and longer-name are more recent than keep, so landing on keep proves batch rows are skipped.
    expect(activateAndRevealWorktree).toHaveBeenCalledTimes(1)
    expect(activateAndRevealWorktree).toHaveBeenCalledWith(...KEEP_FOCUS)
    expect(useAppStore.getState().worktreesByRepo[REPO_ID]).toHaveLength(5)

    await settleAll(pending, 3)
    await waitFor(() => expect(result.current.removalInFlight).toBe(false))
    expect(activateAndRevealWorktree).toHaveBeenCalledTimes(1)
    expect(useAppStore.getState().activeWorktreeId).toBe(worktreeId('keep'))
  })

  it('never moves focus again once the batch is running, even onto an empty screen', async () => {
    seed('active')
    const pending = deferRemovals()
    const { result } = startBatch(['c', 'active', 'longer-name'])
    await settleNext(pending, 0)

    // Closing the successor's last tab leaves no workspace selected on purpose.
    act(() => useAppStore.setState({ activeWorktreeId: null }))
    await settleNext(pending, 1)
    await settleNext(pending, 2)
    await waitFor(() => expect(result.current.removalInFlight).toBe(false))

    expect(activateAndRevealWorktree).toHaveBeenCalledTimes(1)
    expect(useAppStore.getState().activeWorktreeId).toBeNull()
  })

  it('leaves the user on the successor when the active workspace fails to delete', async () => {
    seed('active')
    const pending = deferRemovals()
    const { result } = startBatch(['c', 'active', 'longer-name'])
    await settleNext(pending, 0)

    await waitFor(() => expect(pending.length).toBe(2))
    await act(async () =>
      pending[1].settle({
        removedIds: [],
        removedIdentities: [],
        failures: [{ worktreeId: worktreeId('active'), displayName: 'active', message: 'locked' }]
      })
    )
    await settleNext(pending, 2)
    await waitFor(() => expect(result.current.removalInFlight).toBe(false))

    expect(activateAndRevealWorktree).toHaveBeenCalledTimes(1)
    expect(useAppStore.getState().activeWorktreeId).toBe(worktreeId('keep'))
  })

  it('does not move focus after the dialog closes mid-batch', async () => {
    seed('active')
    const pending = deferRemovals()
    const { unmount } = startBatch(['c', 'active', 'longer-name'])
    await settleNext(pending, 0)

    unmount()
    act(() => useAppStore.setState({ activeWorktreeId: null }))
    await settleNext(pending, 1)
    await settleNext(pending, 2)

    expect(activateAndRevealWorktree).toHaveBeenCalledTimes(1)
    expect(useAppStore.getState().activeWorktreeId).toBeNull()
  })

  it('moves focus at confirm when Delete anyway removes the active workspace', async () => {
    seed('active')
    const pending = deferRemovals()
    useAppStore.setState({ beginUnverifiedRemovalConsent: () => 'attempt-1' })
    const { result } = renderRemoval()

    act(() => result.current.confirmUnverifiedRemoval(candidateFor('active')))
    expect(activateAndRevealWorktree).toHaveBeenCalledWith(worktreeId('longer-name'), {
      revealInSidebar: false
    })

    await settleNext(pending, 0)
    expect(activateAndRevealWorktree).toHaveBeenCalledTimes(1)
  })

  it('keeps deleting when the focus handoff throws', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(activateAndRevealWorktree).mockImplementationOnce(() => {
      throw new Error('activation failed')
    })
    seed('active')

    await runBatch(['c', 'active', 'longer-name'])

    expect(consoleError).toHaveBeenCalled()
    expect(useAppStore.getState().worktreesByRepo[REPO_ID]?.map((wt) => wt.id)).toEqual([
      worktreeId('main'),
      worktreeId('keep')
    ])
    consoleError.mockRestore()
  })

  it('leaves focus alone when the batch does not include the active workspace', async () => {
    seed('keep')

    await runBatch(['c', 'active'])

    expect(useAppStore.getState().activeWorktreeId).toBe(worktreeId('keep'))
    expect(activateAndRevealWorktree).not.toHaveBeenCalled()
  })

  it.each([
    ['another view is open', { activeView: 'settings' as const }],
    ['a workspace is being created', { activePendingCreationId: 'pending-1' }],
    [
      'the same id is active on another host',
      { activeWorkspaceExecutionHostId: 'ssh:host-b' as const }
    ]
  ])('leaves focus alone when %s', async (_label, override) => {
    seed('active')
    useAppStore.setState(override)
    const pending = deferRemovals()
    const { result } = renderRemoval()
    act(() =>
      result.current.openConfirmRemove([
        { ...candidateFor('active'), executionHostId: 'ssh:host-a' }
      ])
    )
    act(() => result.current.confirmRemove())

    expect(activateAndRevealWorktree).not.toHaveBeenCalled()
    await waitFor(() => expect(pending.length).toBe(1))
    await act(async () =>
      pending[0].settle({
        removedIds: [],
        removedIdentities: [],
        failures: [{ worktreeId: worktreeId('active'), displayName: 'active', message: 'locked' }]
      })
    )
    await waitFor(() => expect(result.current.removalInFlight).toBe(false))
    expect(activateAndRevealWorktree).not.toHaveBeenCalled()
  })
})
