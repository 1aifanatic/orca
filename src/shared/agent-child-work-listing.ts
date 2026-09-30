// Which child work each surface lists. The host keeps every record; these pick from them on each
// read, so nothing here is stored and nothing can disagree with the store.
//
// The worktree sidebar lists running children only, from every source it reads (a CLI pane's hook
// roster and a chat session's records alike); a finished child stays in the chat's strip, which
// lists every running child and then the newest finished ones.

import { settledOwnersOfLiveWork } from './agent-status-child-work-liveness'
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

/** Settled views that still own live work, by the rule the host's retention also reads. */
function settledViewOwnersOfLiveWork(views: readonly AgentChildWorkView[]): Set<string> {
  return settledOwnersOfLiveWork(
    views.map((view) => ({
      id: view.id,
      membership: view.membership,
      ...(view.parentChildWorkId ? { ownerId: view.parentChildWorkId } : {})
    }))
  )
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
  const owners = settledViewOwnersOfLiveWork(views)
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
  const owners = settledViewOwnersOfLiveWork(views)
  const running = views.filter((view) => viewRuns(view, owners))
  const room = Math.max(0, STRUCTURED_STRIP_CHILD_WORK_LIMIT - running.length)
  const newestFinished = new Set(
    views
      .filter((view) => !viewRuns(view, owners))
      .sort((a, b) => (b.settledAt ?? b.observedAt) - (a.settledAt ?? a.observedAt))
      .slice(0, room)
      .map((view) => view.id)
  )
  const selected = views.filter((view) => viewRuns(view, owners) || newestFinished.has(view.id))
  // An owner the budget cut leaves its child to the main agent, as a view whose owner is not in
  // the projection reads; otherwise the child would render under a row that is not there.
  const kept = new Set(selected.map((view) => view.id))
  return selected.map((view) => {
    if (view.parentChildWorkId === undefined || kept.has(view.parentChildWorkId)) {
      return view
    }
    const { parentChildWorkId: _cut, ...toMainAgent } = view
    return toMainAgent
  })
}
