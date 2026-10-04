/**
 * Maintains `settledSortEpoch`: the sortEpoch the sidebar sort actually reads.
 *
 * Why in the store: the sidebar used to mirror sortEpoch into React state from an
 * effect, adding a nested update per bump; bursts of flushSync bumps stacked those
 * into "Maximum update depth exceeded" (React #185). A store listener sees every
 * write path — slice actions and runtime patches such as the web session sync — so
 * the settled value stays correct without any component mounted.
 */
import type { StoreApi } from 'zustand'
import type { AppState } from './types'
import { getIndexedAllWorktrees } from './worktree-repo-index'

// Why: time-decaying scores would make rows jump on every bump; coalesce a burst into one re-sort.
export const SORT_SETTLE_MS = 3_000

/** Call once from inside the store's state creator, passing its `api`; returns a disposer. */
export function installSettledSortEpoch(
  api: Pick<StoreApi<AppState>, 'getState' | 'setState' | 'subscribe'>
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  let countedWorktreesByRepo: AppState['worktreesByRepo'] | null = null
  let liveWorktreeCount = 0
  // Why a baseline from the last bump (not the previous write): a row change that skipped
  // its bump (stale-host purge) must not re-sort on its own.
  let liveWorktreeCountAtLastBump = 0

  const countLiveWorktrees = (worktreesByRepo: AppState['worktreesByRepo']): number => {
    if (worktreesByRepo !== countedWorktreesByRepo) {
      countedWorktreesByRepo = worktreesByRepo
      liveWorktreeCount = 0
      for (const worktree of getIndexedAllWorktrees(worktreesByRepo)) {
        if (!worktree.isArchived) {
          liveWorktreeCount++
        }
      }
    }
    return liveWorktreeCount
  }

  const clearTimer = (): void => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  const settle = (): void => {
    clearTimer()
    const { sortEpoch, settledSortEpoch } = api.getState()
    if (settledSortEpoch !== sortEpoch) {
      api.setState({ settledSortEpoch: sortEpoch })
    }
  }

  const unsubscribe = api.subscribe((state, previous) => {
    const epochChanged = state.sortEpoch !== previous.sortEpoch
    if (epochChanged) {
      const count = countLiveWorktrees(state.worktreesByRepo)
      const structuralChange = count !== liveWorktreeCountAtLastBump
      liveWorktreeCountAtLastBump = count
      if (structuralChange) {
        settle()
        return
      }
    }
    if (state.settledSortEpoch === state.sortEpoch) {
      // Why: a store reset (or any write that lands settled) must not leave a stale timer behind.
      clearTimer()
      return
    }
    // Why: Manual is direct manipulation and a mode switch is user intent; neither waits out the window.
    if (state.sortBy === 'manual' || state.sortBy !== previous.sortBy) {
      settle()
      return
    }
    if (epochChanged) {
      clearTimer()
      timer = setTimeout(settle, SORT_SETTLE_MS)
    }
  })

  return () => {
    clearTimer()
    unsubscribe()
  }
}
