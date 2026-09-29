// Which child work each surface lists. The host keeps every record; these pick from them on each
// read, so nothing here is stored and nothing can disagree with the store.
//
// The worktree sidebar lists running children only, from every source it reads (a CLI pane's hook
// roster and a chat session's records alike); a finished child stays in the chat's strip, which
// lists every running child and then the newest finished ones.

import type { AgentChildWorkView } from './agent-status-child-work-view'

/** The strip's row budget. Running children always show, even past it. */
export const STRUCTURED_STRIP_CHILD_WORK_LIMIT = 100

/** The one rule for what the worktree sidebar lists: a child that runs. A finished child whose own
 *  work still runs counts, since it reads monitoring and keeps that work's owner on screen. */
export function worktreeSidebarListsChild(child: {
  settled: boolean
  ownsLiveWork: boolean
}): boolean {
  return !child.settled || child.ownsLiveWork
}

/** Settled views that still own live work, through any depth of ownership. */
function settledOwnersOfLiveWork(views: readonly AgentChildWorkView[]): Set<string> {
  const byId = new Map(views.map((view) => [view.id, view]))
  const owners = new Set<string>()
  for (const view of views) {
    if (view.membership !== 'live') {
      continue
    }
    const seen = new Set([view.id])
    let owner = view.parentChildWorkId ? byId.get(view.parentChildWorkId) : undefined
    while (owner && !seen.has(owner.id)) {
      seen.add(owner.id)
      if (owner.membership === 'settled') {
        owners.add(owner.id)
      }
      owner = owner.parentChildWorkId ? byId.get(owner.parentChildWorkId) : undefined
    }
  }
  return owners
}

function viewRuns(view: AgentChildWorkView, owners: ReadonlySet<string>): boolean {
  return worktreeSidebarListsChild({
    settled: view.membership === 'settled',
    ownsLiveWork: owners.has(view.id)
  })
}

/** The sidebar's children from a session's records: the running ones, in store order. */
export function structuredSidebarChildWork(
  views: readonly AgentChildWorkView[]
): AgentChildWorkView[] {
  const owners = settledOwnersOfLiveWork(views)
  return views.filter((view) => viewRuns(view, owners))
}

/** The strip's children, in store order: every running child, then the newest finished ones, up to
 *  the row budget in all. */
export function structuredStripChildWork(
  views: readonly AgentChildWorkView[]
): AgentChildWorkView[] {
  if (views.length <= STRUCTURED_STRIP_CHILD_WORK_LIMIT) {
    return [...views]
  }
  const owners = settledOwnersOfLiveWork(views)
  const running = views.filter((view) => viewRuns(view, owners))
  const room = Math.max(0, STRUCTURED_STRIP_CHILD_WORK_LIMIT - running.length)
  const newestFinished = new Set(
    views
      .filter((view) => !viewRuns(view, owners))
      .sort((a, b) => (b.settledAt ?? b.observedAt) - (a.settledAt ?? a.observedAt))
      .slice(0, room)
      .map((view) => view.id)
  )
  return views.filter((view) => viewRuns(view, owners) || newestFinished.has(view.id))
}
