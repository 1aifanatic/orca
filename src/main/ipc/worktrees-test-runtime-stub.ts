import type { WorktreeRemovalOutcome } from '../../shared/worktree/removal-outcome'
import { _resetPendingWorktreeRemovalsForTests } from '../worktree-background-removal'
import { harnessRemovalOutcomes } from './worktrees-test-background-removal'
import { vi } from 'vitest'

export type WorktreeRuntimeStub = {
  resolveRemoteTrackingBase: ReturnType<typeof vi.fn>
  hasRemoteTrackingRef: ReturnType<typeof vi.fn>
  getOrStartRemoteTrackingBaseRefresh: ReturnType<typeof vi.fn>
  getOrStartRemoteFetch: ReturnType<typeof vi.fn>
  fetchRemoteWithCache: ReturnType<typeof vi.fn>
  emitWorktreeBaseStatus: ReturnType<typeof vi.fn>
  recordOptimisticReconcileToken: ReturnType<typeof vi.fn>
  reconcileWorktreeBaseStatus: ReturnType<typeof vi.fn>
  clearOptimisticReconcileToken: ReturnType<typeof vi.fn>
  resolveManagedMrBase: ReturnType<typeof vi.fn>
  createTerminal: ReturnType<typeof vi.fn>
  invalidateWorktreeCatalog: ReturnType<typeof vi.fn>
  splitTerminal: ReturnType<typeof vi.fn>
  notifyWorktreesChangedForRemoteClients: ReturnType<typeof vi.fn>
  closeFileWatchersForRemoval: ReturnType<typeof vi.fn>
  acquireFileWatcherRemoval: ReturnType<typeof vi.fn>
  hydrateInferredWorktreeLineage: ReturnType<typeof vi.fn>
  publishWorktreeRemovalChange: ReturnType<typeof vi.fn>
  /** Last background-removal outcome published per worktree id. */
  removalOutcomes: ReadonlyMap<string, WorktreeRemovalOutcome>
}

/** Why: create-flow tests need a minimal runtime; full fetchRemoteWithCache behavior lives in fetch-remote-cache.test.ts. */
export function createWorktreeRuntimeStub(mainWindow?: {
  webContents: { send: (...args: unknown[]) => unknown }
}): WorktreeRuntimeStub {
  // Why here: every harness setup builds a stub, so no removal from an earlier test leaks in.
  _resetPendingWorktreeRemovalsForTests()
  const removalOutcomes = harnessRemovalOutcomes
  removalOutcomes.clear()
  const runtimeStub: WorktreeRuntimeStub = {
    resolveRemoteTrackingBase: vi.fn().mockResolvedValue(null),
    hasRemoteTrackingRef: vi.fn().mockResolvedValue(false),
    getOrStartRemoteTrackingBaseRefresh: vi.fn().mockResolvedValue({ ok: true }),
    getOrStartRemoteFetch: vi.fn().mockResolvedValue({ ok: true }),
    fetchRemoteWithCache: vi.fn().mockResolvedValue(undefined),
    emitWorktreeBaseStatus: vi.fn(),
    recordOptimisticReconcileToken: vi.fn().mockReturnValue('token-1'),
    reconcileWorktreeBaseStatus: vi.fn(),
    clearOptimisticReconcileToken: vi.fn(),
    resolveManagedMrBase: vi.fn().mockResolvedValue({ baseBranch: 'origin/mr-branch' }),
    createTerminal: vi.fn().mockResolvedValue({
      handle: 'term-startup',
      worktreeId: 'repo-1::/workspace/improve-dashboard',
      title: null,
      surface: 'visible'
    }),
    invalidateWorktreeCatalog: vi.fn(),
    splitTerminal: vi.fn().mockResolvedValue({
      handle: 'term-setup',
      tabId: 'tab-startup',
      paneRuntimeId: -1
    }),
    notifyWorktreesChangedForRemoteClients: vi.fn(),
    closeFileWatchersForRemoval: vi.fn().mockResolvedValue(undefined),
    acquireFileWatcherRemoval: vi.fn(),
    hydrateInferredWorktreeLineage: vi.fn().mockResolvedValue(undefined),
    // Mirrors the real runtime notifier, which sends worktrees:changed to the window.
    publishWorktreeRemovalChange: vi.fn((repoId: string, outcome?: WorktreeRemovalOutcome) => {
      if (outcome) {
        removalOutcomes.set(outcome.worktreeId, outcome)
      }
      mainWindow?.webContents.send('worktrees:changed', {
        repoId,
        ...(outcome ? { removalOutcome: outcome } : {})
      })
    }),
    removalOutcomes
  }
  runtimeStub.acquireFileWatcherRemoval.mockImplementation(
    async (worktreePath: string, connectionId?: string) => {
      await (
        runtimeStub.closeFileWatchersForRemoval as (
          worktreePath: string,
          connectionId?: string
        ) => Promise<void>
      )(worktreePath, connectionId)
      return {
        finish: vi.fn().mockResolvedValue(undefined)
      }
    }
  )
  return runtimeStub
}
