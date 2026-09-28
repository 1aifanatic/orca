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

async function settleNext(pending: PendingRemoval[], index: number): Promise<void> {
  await waitFor(() => expect(pending.length).toBeGreaterThan(index))
  await act(async () => pending[index].settle(simulateRemoval(pending[index].ids)))
}

function isQueuedForDeletion(name: string): boolean {
  return useAppStore.getState().deleteStateByWorktreeId[worktreeId(name)]?.isDeleting === true
}

async function runBatch(names: readonly string[]): Promise<void> {
  const { result } = renderRemoval()
  act(() => result.current.openConfirmRemove(names.map(candidateFor)))
  act(() => result.current.confirmRemove())
  await waitFor(() => expect(result.current.removalInFlight).toBe(false))
}

describe('workspace cleanup removal of the active workspace', () => {
  beforeEach(() => {
    vi.mocked(activateAndRevealWorktree).mockReset()
    // Mirrors real activation so later rows see the new active workspace.
    vi.mocked(activateAndRevealWorktree).mockImplementation((id) => {
      useAppStore.setState({ activeWorktreeId: id })
      return false
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    useAppStore.setState(initialState, true)
    Reflect.deleteProperty(window, 'api')
  })

  it('moves focus as soon as the active row is gone, skipping rows still queued', async () => {
    seed('active')
    const pending = deferRemovals()
    const { result } = renderRemoval()
    act(() => result.current.openConfirmRemove(['c', 'active', 'longer-name'].map(candidateFor)))
    act(() => result.current.confirmRemove())

    // Removal order is longest path first: longer-name, active, then c.
    await settleNext(pending, 0)
    expect(activateAndRevealWorktree).not.toHaveBeenCalled()
    await settleNext(pending, 1)

    // c is queued and more recent than keep, so landing on keep proves queued rows are skipped.
    expect(isQueuedForDeletion('c')).toBe(true)
    expect(activateAndRevealWorktree).toHaveBeenCalledTimes(1)
    expect(activateAndRevealWorktree).toHaveBeenCalledWith(worktreeId('keep'), {
      revealInSidebar: false
    })

    await settleNext(pending, 2)
    await waitFor(() => expect(result.current.removalInFlight).toBe(false))
    expect(activateAndRevealWorktree).toHaveBeenCalledTimes(1)
    expect(useAppStore.getState().activeWorktreeId).toBe(worktreeId('keep'))
  })

  it('leaves an empty screen the user chose while later rows are still deleting', async () => {
    seed('active')
    const pending = deferRemovals()
    const { result } = renderRemoval()
    act(() => result.current.openConfirmRemove(['c', 'active', 'longer-name'].map(candidateFor)))
    act(() => result.current.confirmRemove())
    await settleNext(pending, 0)
    await settleNext(pending, 1)
    expect(activateAndRevealWorktree).toHaveBeenCalledTimes(1)

    // Closing the successor's last tab leaves no workspace selected on purpose.
    act(() => useAppStore.setState({ activeWorktreeId: null }))
    await settleNext(pending, 2)
    await waitFor(() => expect(result.current.removalInFlight).toBe(false))

    expect(activateAndRevealWorktree).toHaveBeenCalledTimes(1)
    expect(useAppStore.getState().activeWorktreeId).toBeNull()
  })

  it('keeps deleting later rows when the focus handoff throws', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(activateAndRevealWorktree).mockImplementationOnce(() => {
      throw new Error('activation failed')
    })
    seed('active')

    await runBatch(['c', 'active', 'longer-name'])

    expect(useAppStore.getState().worktreesByRepo[REPO_ID]?.map((wt) => wt.id)).toEqual([
      worktreeId('main'),
      worktreeId('keep')
    ])
    consoleError.mockRestore()
  })

  it('keeps focus on the active workspace when its delete fails', async () => {
    seed('active')
    const pending = deferRemovals()
    const { result } = renderRemoval()
    act(() => result.current.openConfirmRemove(['c', 'active'].map(candidateFor)))
    act(() => result.current.confirmRemove())

    await waitFor(() => expect(pending.length).toBe(1))
    await act(async () =>
      pending[0].settle({
        removedIds: [],
        removedIdentities: [],
        failures: [{ worktreeId: worktreeId('active'), displayName: 'active', message: 'locked' }]
      })
    )
    await settleNext(pending, 1)
    await waitFor(() => expect(result.current.removalInFlight).toBe(false))

    expect(useAppStore.getState().activeWorktreeId).toBe(worktreeId('active'))
    expect(activateAndRevealWorktree).not.toHaveBeenCalled()
  })

  it('hands focus off even when the dialog closed before the row settled', async () => {
    seed('active')
    const pending = deferRemovals()
    const { result, unmount } = renderRemoval()
    act(() => result.current.openConfirmRemove([candidateFor('active')]))
    act(() => result.current.confirmRemove())
    await waitFor(() => expect(pending.length).toBe(1))

    unmount()
    await settleNext(pending, 0)

    expect(activateAndRevealWorktree).toHaveBeenCalledWith(worktreeId('longer-name'), {
      revealInSidebar: false
    })
  })

  it('hands focus off when the active row settles after the batch timed out', async () => {
    vi.useFakeTimers()
    seed('active')
    const pending = deferRemovals()
    const { result } = renderRemoval()
    act(() => result.current.openConfirmRemove([candidateFor('active')]))
    act(() => result.current.confirmRemove())

    // Past the removal timeout and its grace period, so the batch settles without this row.
    await act(async () => vi.advanceTimersByTimeAsync(130_000))
    expect(result.current.removalInFlight).toBe(false)
    expect(activateAndRevealWorktree).not.toHaveBeenCalled()

    await act(async () => pending[0].settle(simulateRemoval(pending[0].ids)))

    expect(activateAndRevealWorktree).toHaveBeenCalledWith(worktreeId('longer-name'), {
      revealInSidebar: false
    })
  })

  it('hands focus off after Delete anyway removes the active workspace', async () => {
    seed('active')
    useAppStore.setState({ beginUnverifiedRemovalConsent: () => 'attempt-1' })
    const { result } = renderRemoval()

    act(() => result.current.confirmUnverifiedRemoval(candidateFor('active')))

    await waitFor(() =>
      expect(activateAndRevealWorktree).toHaveBeenCalledWith(worktreeId('longer-name'), {
        revealInSidebar: false
      })
    )
    expect(activateAndRevealWorktree).toHaveBeenCalledTimes(1)
  })

  it('leaves focus alone when the batch does not include the active workspace', async () => {
    seed('keep')

    await runBatch(['c', 'active'])

    expect(useAppStore.getState().activeWorktreeId).toBe(worktreeId('keep'))
    expect(activateAndRevealWorktree).not.toHaveBeenCalled()
  })
})
