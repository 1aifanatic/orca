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

async function runBatch(names: readonly string[]): Promise<void> {
  const { result } = renderRemoval()
  act(() => result.current.openConfirmRemove(names.map(candidateFor)))
  act(() => result.current.confirmRemove())
  await waitFor(() => expect(result.current.removalInFlight).toBe(false))
}

describe('workspace cleanup removal of the active workspace', () => {
  beforeEach(() => {
    vi.mocked(activateAndRevealWorktree).mockClear()
  })

  afterEach(() => {
    useAppStore.setState(initialState, true)
    Reflect.deleteProperty(window, 'api')
  })

  it('hands focus to a surviving sibling when the active workspace is mid-batch', async () => {
    seed('active')

    // Removal order is longest path first, so the active row is neither first nor last.
    await runBatch(['c', 'active', 'longer-name'])

    expect(useAppStore.getState().worktreesByRepo[REPO_ID]?.map((wt) => wt.id)).toEqual([
      worktreeId('main'),
      worktreeId('keep')
    ])
    expect(activateAndRevealWorktree).toHaveBeenCalledTimes(1)
    expect(activateAndRevealWorktree).toHaveBeenCalledWith(worktreeId('keep'), {
      revealInSidebar: false
    })
  })

  it('hands focus off even when the dialog closed before the batch settled', async () => {
    seed('active')
    let finishRemoval: () => void = () => {}
    useAppStore.setState({
      removeWorkspaceCleanupCandidates: vi.fn(
        (ids: readonly string[]) =>
          new Promise<WorkspaceCleanupRemoveResult>((resolve) => {
            finishRemoval = () => resolve(simulateRemoval(ids))
          })
      )
    })
    const { result, unmount } = renderRemoval()
    act(() => result.current.openConfirmRemove([candidateFor('active')]))
    act(() => result.current.confirmRemove())
    await waitFor(() =>
      expect(useAppStore.getState().removeWorkspaceCleanupCandidates).toHaveBeenCalled()
    )

    unmount()
    await act(async () => finishRemoval())

    await waitFor(() =>
      expect(activateAndRevealWorktree).toHaveBeenCalledWith(worktreeId('longer-name'), {
        revealInSidebar: false
      })
    )
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
