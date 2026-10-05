import { detectLanguage } from '../../shared/language-detect'
import { hashMarkdownContent } from '../../shared/mobile-markdown-document'
import {
  projectMobileSessionFileTab,
  projectMobileSessionMarkdownTab,
  type MobileSessionEditorFileFacts
} from '../../shared/mobile-session-editor-tab-projection'
import type {
  RuntimeMobileSessionFileTab,
  RuntimeMobileSessionMarkdownTab,
  RuntimeMobileSessionSnapshotTab,
  RuntimeMobileSessionTabGroup,
  RuntimeMobileSessionTabsSnapshot
} from '../../shared/runtime-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { listHostEditTabs } from './host-editor-session-model'
import type { HostDiffTabRecord } from './host-editor-tab-state'
import {
  collectHeadlessTopLevelTabOrder,
  getHeadlessMobileSessionGroupId
} from './mobile-session-layout-projection'

export type HostEditorMobileTab = {
  tab: RuntimeMobileSessionMarkdownTab | RuntimeMobileSessionFileTab
  groupId: string | null
  fileId: string
}

function isEditorSnapshotTab(
  tab: RuntimeMobileSessionSnapshotTab
): tab is RuntimeMobileSessionMarkdownTab | RuntimeMobileSessionFileTab {
  return tab.type === 'markdown' || tab.type === 'file'
}

/** Editor tabs a host with no window publishes for one worktree: persisted edits, then live diffs. */
export function buildHostEditorMobileTabs(
  session: WorkspaceSessionState | null,
  worktreeId: string,
  diffs: readonly HostDiffTabRecord[]
): HostEditorMobileTab[] {
  const tabs: HostEditorMobileTab[] = []
  for (const record of session ? listHostEditTabs(session, worktreeId) : []) {
    const draft = record.file.readOnly === true ? undefined : record.file.dirtyDraftContent
    const facts: MobileSessionEditorFileFacts = {
      id: record.fileId,
      filePath: record.file.filePath,
      relativePath: record.file.relativePath,
      // Why re-detect: windows re-detect on restore; stored ids can predate newer extensions.
      language: detectLanguage(record.file.relativePath || record.file.filePath),
      mode: 'edit',
      isDirty: draft !== undefined
    }
    const presentation = {
      tabId: record.tabId,
      isActive: false,
      color: record.color,
      isPinned: record.isPinned
    }
    const tab =
      projectMobileSessionMarkdownTab(
        presentation,
        facts,
        facts,
        draft === undefined ? undefined : hashMarkdownContent(draft)
      ) ?? projectMobileSessionFileTab(presentation, facts)
    tabs.push({ tab, groupId: record.groupId, fileId: record.fileId })
  }
  for (const diff of diffs) {
    tabs.push({
      tab: projectMobileSessionFileTab(
        { tabId: diff.tabId, isActive: false },
        {
          id: diff.fileId,
          filePath: diff.filePath,
          relativePath: diff.relativePath,
          language: diff.language,
          mode: 'diff',
          isDirty: false,
          diffSource: diff.diffSource
        }
      ),
      groupId: diff.groupId,
      fileId: diff.fileId
    })
  }
  return tabs
}

function insertByPersistedOrder(
  tabOrder: readonly string[],
  tabId: string,
  persistedOrder: readonly string[] | undefined
): string[] {
  const next = tabOrder.filter((id) => id !== tabId)
  const persistedIndex = persistedOrder?.indexOf(tabId) ?? -1
  if (!persistedOrder || persistedIndex < 0) {
    return [...next, tabId]
  }
  for (let index = persistedIndex - 1; index >= 0; index -= 1) {
    const anchor = next.indexOf(persistedOrder[index]!)
    if (anchor !== -1) {
      next.splice(anchor + 1, 0, tabId)
      return next
    }
  }
  return [tabId, ...next]
}

/**
 * Replaces a headless snapshot's editor tabs with the host's current editor tabs, placing each in
 * its persisted group and position. Re-derived on every hydrate, so a closed tab cannot come back.
 */
export type HostEditorFocus = {
  /** A tab the host just focused (an open or activation that targets the host). */
  tabId?: string
  /** A fresh build has no current focus of its own, so the persisted one wins. */
  preferPersistedEditorFocus?: boolean
}

export function overlayHostEditorTabs(
  snapshot: RuntimeMobileSessionTabsSnapshot,
  editors: readonly HostEditorMobileTab[],
  session: WorkspaceSessionState | null,
  focus: HostEditorFocus = {}
): RuntimeMobileSessionTabsSnapshot {
  const worktreeId = snapshot.worktree
  const baseTabs = snapshot.tabs.filter((tab) => !isEditorSnapshotTab(tab))
  const previousEditorIds = new Set(snapshot.tabs.filter(isEditorSnapshotTab).map((tab) => tab.id))
  const editorIds = new Set(editors.map((editor) => editor.tab.id))
  let groups: RuntimeMobileSessionTabGroup[] = (snapshot.tabGroups ?? []).map((group) => {
    const tabOrder = group.tabOrder.filter((id) => !previousEditorIds.has(id) || editorIds.has(id))
    return {
      ...group,
      tabOrder,
      activeTabId:
        group.activeTabId && tabOrder.includes(group.activeTabId) ? group.activeTabId : null
    }
  })
  if (groups.length === 0 && editors.length > 0) {
    groups = [
      {
        id: snapshot.activeGroupId ?? getHeadlessMobileSessionGroupId(worktreeId),
        activeTabId: null,
        tabOrder: collectHeadlessTopLevelTabOrder(baseTabs)
      }
    ]
  }
  const persistedGroupsById = new Map(
    (session?.tabGroups?.[worktreeId] ?? []).map((group) => [group.id, group])
  )
  // Why: a terminal-only rebuild drops a persisted group that holds only editors.
  for (const editor of editors) {
    const persistedGroup = editor.groupId ? persistedGroupsById.get(editor.groupId) : undefined
    if (persistedGroup && !groups.some((group) => group.id === persistedGroup.id)) {
      groups.push({ id: persistedGroup.id, activeTabId: persistedGroup.activeTabId, tabOrder: [] })
    }
  }
  for (const editor of editors) {
    const alreadyPlaced = groups.find((group) => group.tabOrder.includes(editor.tab.id))
    const target =
      alreadyPlaced ??
      groups.find((group) => group.id === editor.groupId) ??
      groups.find((group) => group.id === snapshot.activeGroupId) ??
      groups[0]!
    if (alreadyPlaced) {
      continue
    }
    const persistedOrder = persistedGroupsById.get(target.id)?.tabOrder
    groups = groups.map((group) =>
      group.id === target.id
        ? {
            ...group,
            tabOrder: insertByPersistedOrder(group.tabOrder, editor.tab.id, persistedOrder)
          }
        : group
    )
  }
  groups = groups.filter((group, index) => group.tabOrder.length > 0 || index === 0)

  const candidateTabs = [...baseTabs, ...editors.map((editor) => editor.tab)]
  const activeTabId = pickActiveTabId(
    snapshot,
    new Set(candidateTabs.map((tab) => tab.id)),
    editors,
    session,
    focus
  )
  const nextTabs = candidateTabs.map((tab) =>
    isEditorSnapshotTab(tab) || tab.id === activeTabId || tab.isActive
      ? { ...tab, isActive: tab.id === activeTabId }
      : tab
  )
  const activeTab = nextTabs.find((tab) => tab.id === activeTabId) ?? null
  const activeTopLevelId = activeTab
    ? activeTab.type === 'terminal'
      ? activeTab.parentTabId
      : activeTab.id
    : null
  const activeGroup = activeTopLevelId
    ? groups.find((group) => group.tabOrder.includes(activeTopLevelId))
    : undefined
  groups = groups.map((group) => {
    if (group === activeGroup && activeTopLevelId) {
      return { ...group, activeTabId: activeTopLevelId }
    }
    return group.activeTabId ? group : { ...group, activeTabId: group.tabOrder[0] ?? null }
  })
  return {
    ...snapshot,
    activeGroupId: activeGroup?.id ?? snapshot.activeGroupId ?? groups[0]?.id ?? null,
    activeTabId: activeTab?.id ?? null,
    activeTabType: activeTab?.type ?? null,
    tabGroups: groups,
    tabs: nextTabs
  }
}

function persistedEditorFocus(
  worktreeId: string,
  editors: readonly HostEditorMobileTab[],
  session: WorkspaceSessionState | null
): HostEditorMobileTab | undefined {
  const persistedActiveFileId = session?.activeFileIdByWorktree?.[worktreeId]
  if (session?.activeTabTypeByWorktree?.[worktreeId] !== 'editor' || !persistedActiveFileId) {
    return undefined
  }
  const activeGroupId = session.activeGroupIdByWorktree?.[worktreeId]
  const persistedGroupActiveTabId = session.tabGroups?.[worktreeId]?.find(
    (group) => group.id === activeGroupId
  )?.activeTabId
  const candidates = editors.filter((editor) => editor.fileId === persistedActiveFileId)
  return candidates.find((editor) => editor.tab.id === persistedGroupActiveTabId) ?? candidates[0]
}

/**
 * Focus order: an explicit host focus, then whatever the snapshot already shows (so a later
 * terminal activation is not overridden), then the persisted editor focus a restart restores.
 */
function pickActiveTabId(
  snapshot: RuntimeMobileSessionTabsSnapshot,
  nextTabIds: ReadonlySet<string>,
  editors: readonly HostEditorMobileTab[],
  session: WorkspaceSessionState | null,
  focus: HostEditorFocus
): string | null {
  if (focus.tabId && nextTabIds.has(focus.tabId)) {
    return focus.tabId
  }
  const persisted = persistedEditorFocus(snapshot.worktree, editors, session)
  if (focus.preferPersistedEditorFocus && persisted) {
    return persisted.tab.id
  }
  if (snapshot.activeTabId && nextTabIds.has(snapshot.activeTabId)) {
    return snapshot.activeTabId
  }
  if (persisted) {
    return persisted.tab.id
  }
  // Why: a document-only session has nothing else to focus.
  return snapshot.tabs.some((tab) => !isEditorSnapshotTab(tab))
    ? null
    : (editors[0]?.tab.id ?? null)
}
