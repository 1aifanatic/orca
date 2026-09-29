// Which of a session's child records each surface lists. The store keeps every record; these pick
// from them on each read, so nothing here is stored and nothing can disagree with the store.
//
// The sidebar (the status summary) lists running children only; a finished child stays in the
// chat's strip, which lists every running child and then the newest finished ones.

import type { AgentChildWorkView } from './agent-status-child-work-view'

/** The strip's row budget. Running children always show, even past it. */
export const STRUCTURED_STRIP_CHILD_WORK_LIMIT = 100

/** Settled children that still own live work: they read as monitoring, not finished, and keep
 *  that work's owner on screen. */
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

function isRunning(view: AgentChildWorkView, owners: ReadonlySet<string>): boolean {
  return view.membership === 'live' || owners.has(view.id)
}

/** The sidebar's children: the running ones, in store order. */
export function structuredSidebarChildWork(
  views: readonly AgentChildWorkView[]
): AgentChildWorkView[] {
  const owners = settledOwnersOfLiveWork(views)
  return views.filter((view) => isRunning(view, owners))
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
  const running = views.filter((view) => isRunning(view, owners))
  const room = Math.max(0, STRUCTURED_STRIP_CHILD_WORK_LIMIT - running.length)
  const newestFinished = new Set(
    views
      .filter((view) => !isRunning(view, owners))
      .sort((a, b) => (b.settledAt ?? b.observedAt) - (a.settledAt ?? a.observedAt))
      .slice(0, room)
      .map((view) => view.id)
  )
  return views.filter((view) => isRunning(view, owners) || newestFinished.has(view.id))
}
