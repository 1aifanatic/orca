import type { Tab, TabGroup } from '../../../../shared/tab-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { AppState } from '../types'
import {
  dedupeTabOrder,
  ensureGroup,
  pickNextActiveTab,
  sanitizeRecentTabIds
} from '../slices/tab-group-state'

type UnifiedTabsPatch = Partial<
  Pick<
    AppState,
    'unifiedTabsByWorktree' | 'groupsByWorktree' | 'activeGroupIdByWorktree' | 'layoutByWorktree'
  >
>

function isTerminalEntryFor(tab: Tab, terminalIds: ReadonlySet<string>): boolean {
  return (
    tab.contentType === 'terminal' && (terminalIds.has(tab.entityId) || terminalIds.has(tab.id))
  )
}

function withoutTabs(group: TabGroup, removed: ReadonlySet<string>): TabGroup {
  const tabOrder = group.tabOrder.filter((id) => !removed.has(id))
  if (tabOrder.length === group.tabOrder.length) {
    return group
  }
  const activeTabId =
    group.activeTabId && removed.has(group.activeTabId)
      ? pickNextActiveTab(tabOrder, group.recentTabIds, group.activeTabId)
      : group.activeTabId
  return {
    ...group,
    tabOrder,
    activeTabId,
    recentTabIds: sanitizeRecentTabIds(group.recentTabIds, tabOrder)
  }
}

function unifiedTerminalTab(tab: TerminalTab, groupId: string, sortOrder: number): Tab {
  return {
    id: tab.id,
    entityId: tab.id,
    groupId,
    worktreeId: tab.worktreeId,
    contentType: 'terminal',
    label: tab.title,
    ...(tab.quickCommandLabel?.trim() ? { quickCommandLabel: tab.quickCommandLabel.trim() } : {}),
    customLabel: tab.customTitle,
    color: tab.color,
    sortOrder,
    createdAt: tab.createdAt
  }
}

/** Joins terminal rows to unified tabs on `entityId` or `id`; a new row joins the active group. */
export function mirrorTerminalUnifiedTabs(
  state: AppState,
  worktreeId: string,
  added: readonly TerminalTab[],
  removedIds: readonly string[]
): UnifiedTabsPatch {
  const current = state.unifiedTabsByWorktree[worktreeId] ?? []
  const removedSet = new Set(removedIds)
  const represented = new Set(
    current.flatMap((tab) => (tab.contentType === 'terminal' ? [tab.id, tab.entityId] : []))
  )
  const joining = added.filter((tab) => !represented.has(tab.id))
  const removedEntryIds = new Set(
    current.filter((tab) => isTerminalEntryFor(tab, removedSet)).map((tab) => tab.id)
  )
  if (joining.length === 0 && removedEntryIds.size === 0) {
    return {}
  }
  const ensured =
    joining.length > 0
      ? ensureGroup(
          state.groupsByWorktree,
          state.activeGroupIdByWorktree,
          worktreeId,
          state.activeGroupIdByWorktree[worktreeId]
        )
      : null
  const groups = (ensured?.groupsByWorktree ?? state.groupsByWorktree)[worktreeId] ?? []
  const target = ensured?.group
  const joined = target
    ? joining.map((tab, index) =>
        unifiedTerminalTab(tab, target.id, target.tabOrder.length + index)
      )
    : []
  const nextGroups = groups.map((group) => {
    const pruned = withoutTabs(group, removedEntryIds)
    if (group.id !== target?.id) {
      return pruned
    }
    const tabOrder = dedupeTabOrder([...pruned.tabOrder, ...joined.map((tab) => tab.id)])
    return { ...pruned, tabOrder, activeTabId: pruned.activeTabId ?? tabOrder[0] ?? null }
  })
  return {
    unifiedTabsByWorktree: {
      ...state.unifiedTabsByWorktree,
      [worktreeId]: [...current.filter((tab) => !removedEntryIds.has(tab.id)), ...joined]
    },
    groupsByWorktree: { ...state.groupsByWorktree, [worktreeId]: nextGroups },
    ...(ensured && ensured.activeGroupIdByWorktree !== state.activeGroupIdByWorktree
      ? {
          activeGroupIdByWorktree: ensured.activeGroupIdByWorktree,
          layoutByWorktree: {
            ...state.layoutByWorktree,
            [worktreeId]: state.layoutByWorktree[worktreeId] ?? {
              type: 'leaf',
              groupId: ensured.group.id
            }
          }
        }
      : {})
  }
}
