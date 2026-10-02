// Which structured chats a launch shows first, from the workspace session the renderer saves.

import { LOCAL_EXECUTION_HOST_ID } from './execution-host'
import type { WorkspaceSessionState } from './workspace-session-state-types'

/**
 * The chats a launch shows first, each tab group's active tab (the active worktree's first, and in
 * each worktree its focused group first), ahead of the rest in their given order. Read from the
 * groups because `activeTabIdByWorktree` only ever holds a terminal's tab. Any agent: this orders,
 * it restores nothing.
 */
export function orderOnScreenStructuredAgentSessionsFirst(
  sessionIds: readonly string[],
  session: WorkspaceSessionState | null
): string[] {
  const tabsById = new Map(
    Object.values(session?.unifiedTabs ?? {})
      .flat()
      .map((tab) => [tab.id, tab])
  )
  const groupsByWorktree = session?.tabGroups ?? {}
  const activeWorktree = session?.activeWorktreeId ?? null
  const worktrees = [
    ...(activeWorktree && groupsByWorktree[activeWorktree] ? [activeWorktree] : []),
    ...Object.keys(groupsByWorktree).filter((worktreeId) => worktreeId !== activeWorktree)
  ]
  const listed = new Set(sessionIds)
  const first = new Set<string>()
  for (const worktreeId of worktrees) {
    const groups = groupsByWorktree[worktreeId] ?? []
    const focused = session?.activeGroupIdByWorktree?.[worktreeId]
    for (const group of [
      ...groups.filter((candidate) => candidate.id === focused),
      ...groups.filter((candidate) => candidate.id !== focused)
    ]) {
      const tab = group.activeTabId ? tabsById.get(group.activeTabId) : undefined
      const local = !tab?.executionHostId || tab.executionHostId === LOCAL_EXECUTION_HOST_ID
      if (tab?.contentType === 'agent-session' && local && listed.has(tab.entityId)) {
        first.add(tab.entityId)
      }
    }
  }
  return [...first, ...sessionIds.filter((sessionId) => !first.has(sessionId))]
}
