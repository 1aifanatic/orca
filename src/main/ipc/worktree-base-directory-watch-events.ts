import {
  collectLocalWorktreeBaseChanges,
  collectRemoteWorktreeBaseChanges,
  hasCollectedWorktreeBaseChanges,
  type WorktreeBaseCollectedChanges
} from './worktree-base-directory-change-collector'
import { markWorktreeMembershipCommonDirDirty } from '../git/worktree-membership/worktree-membership-store'
import { FULL_MEMBERSHIP_SCOPE } from '../git/worktree-membership/worktree-membership-model'
import {
  scheduleWorktreeBaseNotification,
  type WorktreeBaseNotificationWatch
} from './worktree-base-directory-notifications'
import {
  invalidateActiveGitStatusRefResolution,
  invalidateGitStatusRefResolutionForPaths
} from './worktree-git-status-ref-watch'
import type { WorktreeWatcherFailureRefreshCooldown } from './worktree-watcher-failure-refresh-cooldown'

export type ActiveWatch = WorktreeBaseNotificationWatch & {
  subscription: { unsubscribe: () => Promise<void> }
  gitStatusRefPaths: Set<string>
  watcherFailureRefresh: WorktreeWatcherFailureRefreshCooldown
}

/**
 * Mark the git-common dir's membership model dirty. Runs before the window guard: the model serves
 * CLI and mobile reads while the window is closed, and a mark only lets the next read skip its memo.
 */
function markLocalMembershipDirty(
  watch: ActiveWatch,
  changes: WorktreeBaseCollectedChanges | null
): void {
  if (watch.disposed || watch.kind !== 'git-common' || watch.connectionId) {
    return
  }
  if (!changes) {
    markWorktreeMembershipCommonDirDirty(watch.path, FULL_MEMBERSHIP_SCOPE)
    return
  }
  const scope = changes.headIdentityScope
  const listing = scope.listing || changes.structureRepoIds.length > 0
  if (scope.all || listing || scope.primary || scope.entryNames.size > 0) {
    markWorktreeMembershipCommonDirDirty(watch.path, {
      all: scope.all,
      listing,
      primary: scope.primary,
      entryKeys: scope.entryNames
    })
  }
}

export function handleLocalWatchEvents(
  watch: ActiveWatch,
  error: Error | null,
  events: { type: 'create' | 'update' | 'delete'; path: string }[],
  getActiveWatches: () => Iterable<ActiveWatch>
): void {
  const changes = error ? null : collectLocalWorktreeBaseChanges(watch, events)
  markLocalMembershipDirty(watch, changes)
  if (watch.disposed || watch.mainWindow.isDestroyed()) {
    return
  }
  if (!changes) {
    console.warn(`[worktree-base-watcher] watcher failed for ${watch.path}:`, error)
    invalidateActiveGitStatusRefResolution(watch, getActiveWatches)
    if (watch.watcherFailureRefresh.consume()) {
      scheduleWorktreeBaseNotification(watch, { structureRepoIds: [...watch.repos.keys()] })
    }
    return
  }
  watch.watcherFailureRefresh.reset()
  invalidateGitStatusRefResolutionForPaths(
    watch,
    events.map((event) => event.path),
    getActiveWatches
  )
  if (hasCollectedWorktreeBaseChanges(changes)) {
    scheduleWorktreeBaseNotification(watch, changes)
  }
}

// Why: after a dropped event batch nothing about the prior state can be
// trusted — widen unconditionally (structural + status + head-identity),
// same shape as the remote overflow branch below, bypassing the watcher-error
// cooldown so a burst of overflows during one bulk op cannot suppress the
// refresh the fleet actually needs.
export function handleWatchOverflow(
  watch: ActiveWatch,
  getActiveWatches: () => Iterable<ActiveWatch>
): void {
  markLocalMembershipDirty(watch, null)
  if (watch.disposed || watch.mainWindow.isDestroyed()) {
    return
  }
  invalidateActiveGitStatusRefResolution(watch, getActiveWatches)
  scheduleWorktreeBaseNotification(watch, { structureRepoIds: [...watch.repos.keys()] })
}

export function handleRemoteWatchEvents(
  watch: ActiveWatch,
  events: Parameters<typeof collectRemoteWorktreeBaseChanges>[1],
  getActiveWatches: () => Iterable<ActiveWatch>
): void {
  if (watch.disposed || watch.mainWindow.isDestroyed()) {
    return
  }
  invalidateGitStatusRefResolutionForPaths(
    watch,
    events.flatMap((event) =>
      event.kind === 'overflow' ? [] : [event.absolutePath, event.oldAbsolutePath]
    ),
    getActiveWatches
  )
  const changes = collectRemoteWorktreeBaseChanges(watch, events)
  if (changes.overflow) {
    handleWatchOverflow(watch, getActiveWatches)
    return
  }
  if (hasCollectedWorktreeBaseChanges(changes)) {
    scheduleWorktreeBaseNotification(watch, changes)
  }
}
