import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import type { Tab } from '../../shared/tab-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'

function savedSessionId(tab: Tab): string | null {
  if (tab.executionHostId && tab.executionHostId !== LOCAL_EXECUTION_HOST_ID) {
    return null
  }
  if (tab.agentSessionAgent === 'claude') {
    return null
  }
  return tab.contentType === 'agent-session' ? tab.entityId : null
}

/** Visible chats restore first; closed historical journals stay lazy. */
export function collectSavedStructuredAgentSessionIds(
  session: WorkspaceSessionState | null
): string[] {
  const tabs = Object.values(session?.unifiedTabs ?? {}).flat()
  const activeTabIds = new Set(
    Object.values(session?.activeTabIdByWorktree ?? {}).filter(
      (tabId): tabId is string => typeof tabId === 'string'
    )
  )
  const selected: string[] = []
  const seen = new Set<string>()
  const add = (tab: Tab): void => {
    const sessionId = savedSessionId(tab)
    if (sessionId && !seen.has(sessionId)) {
      seen.add(sessionId)
      selected.push(sessionId)
    }
  }
  for (const tab of tabs) {
    if (activeTabIds.has(tab.id)) {
      add(tab)
    }
  }
  for (const tab of tabs) {
    add(tab)
  }
  return selected
}

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
