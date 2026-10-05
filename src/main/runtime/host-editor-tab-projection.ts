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
import type { TabGroupLayoutNode } from '../../shared/tab-types'
import type {
  PersistedOpenFile,
  WorkspaceSessionState
} from '../../shared/workspace-session-state-types'
import { isUnifiedWorkspaceSession, listHostEditTabs } from './host-editor-session-model'
import type { HostDiffTabRecord } from './host-editor-tab-state'
import { isSafeMobileRelativePath } from './runtime-file-command-host'
import { joinWorktreeRelativePath } from './runtime-relative-paths'
import {
  collectHeadlessTopLevelTabOrder,
  getHeadlessMobileSessionGroupId
} from './mobile-session-layout-projection'
import {
  pruneTabGroupLayoutAfterRetirement,
  repairMobileSessionTabGroupsAfterRetirement
} from './mobile-session-terminal-retirement'

export type HostEditorMobileTab = {
  tab: RuntimeMobileSessionMarkdownTab | RuntimeMobileSessionFileTab
  groupId: string | null
  fileId: string
  /** The id persisted group orders hold for this tab; null for a live-only diff or a legacy row. */
  persistedTabId: string | null
}

function isEditorSnapshotTab(
  tab: RuntimeMobileSessionSnapshotTab
): tab is RuntimeMobileSessionMarkdownTab | RuntimeMobileSessionFileTab {
  return tab.type === 'markdown' || tab.type === 'file'
}

export function sameFilePath(a: string, b: string): boolean {
  return a.replace(/\\/g, '/') === b.replace(/\\/g, '/')
}

/** Whether a phone may reach a row's file: on this workspace's host, under its root. */
export function isHostEditRowInsideWorkspace(
  file: PersistedOpenFile,
  workspaceRoot: string | null
): boolean {
  if (file.externalSshTargetId?.trim() || !isSafeMobileRelativePath(file.relativePath)) {
    return false
  }
  return (
    workspaceRoot === null ||
    sameFilePath(joinWorktreeRelativePath(workspaceRoot, file.relativePath), file.filePath)
  )
}

/**
 * Editor tabs a host with no window publishes for one worktree: persisted edits, then live diffs.
 * Rows naming files outside the workspace stay in the session but are not listed, since no phone
 * read of them is allowed.
 */
export function buildHostEditorMobileTabs(
  session: WorkspaceSessionState | null,
  worktreeId: string,
  diffs: readonly HostDiffTabRecord[],
  workspaceRoot: string | null
): HostEditorMobileTab[] {
  const tabs: HostEditorMobileTab[] = []
  for (const record of session ? listHostEditTabs(session, worktreeId) : []) {
    if (!isHostEditRowInsideWorkspace(record.file, workspaceRoot)) {
      continue
    }
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
    tabs.push({
      tab,
      groupId: record.groupId,
      fileId: record.fileId,
      persistedTabId: record.wrapperId
    })
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
      fileId: diff.fileId,
      persistedTabId: null
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

export type HostEditorFocus = {
  /** A tab the host just focused (an open or activation that targets the host). */
  tabId?: string
  /** A fresh build has no current focus of its own, so the persisted one wins. */
  preferPersistedEditorFocus?: boolean
}

type ProjectedTabGroups = {
  groups: RuntimeMobileSessionTabGroup[]
  layout: TabGroupLayoutNode | undefined
}

/**
 * A unified session's groups are the window's groups, so every tab (terminal, browser, editor)
 * is placed through them; a separate terminal group would show phones a split the window never had.
 */
function projectPersistedTabGroups(
  snapshot: RuntimeMobileSessionTabsSnapshot,
  baseTabs: readonly RuntimeMobileSessionSnapshotTab[],
  editors: readonly HostEditorMobileTab[],
  session: WorkspaceSessionState
): ProjectedTabGroups | null {
  const worktreeId = snapshot.worktree
  const persisted = session.tabGroups?.[worktreeId] ?? []
  if (persisted.length === 0) {
    return null
  }
  const snapshotIdByPersistedId = new Map(
    editors.flatMap((editor) =>
      editor.persistedTabId && editor.persistedTabId !== editor.tab.id
        ? [[editor.persistedTabId, editor.tab.id] as const]
        : []
    )
  )
  const toSnapshotId = (tabId: string): string => snapshotIdByPersistedId.get(tabId) ?? tabId
  const topLevelIds = [
    ...collectHeadlessTopLevelTabOrder(baseTabs),
    ...editors.map((editor) => editor.tab.id)
  ]
  const present = new Set(topLevelIds)
  const groups: RuntimeMobileSessionTabGroup[] = persisted.map((group) => ({
    id: group.id,
    activeTabId: group.activeTabId ? toSnapshotId(group.activeTabId) : null,
    tabOrder: group.tabOrder.map(toSnapshotId).filter((tabId) => present.has(tabId)),
    ...(group.recentTabIds ? { recentTabIds: group.recentTabIds.map(toSnapshotId) } : {})
  }))
  const placed = new Set(groups.flatMap((group) => group.tabOrder))
  const groupIdByEditorId = new Map(editors.map((editor) => [editor.tab.id, editor.groupId]))
  const groupIdByWrapperId = new Map(
    (session.unifiedTabs?.[worktreeId] ?? []).map((tab) => [toSnapshotId(tab.id), tab.groupId])
  )
  const snapshotGroupByTabId = new Map(
    (snapshot.tabGroups ?? []).flatMap((group) =>
      group.tabOrder.map((tabId) => [tabId, group] as const)
    )
  )
  for (const tabId of topLevelIds) {
    if (placed.has(tabId)) {
      continue
    }
    // Why: live-only tabs (host diffs, unwrapped terminals) keep the group and position phones saw.
    const snapshotGroup = snapshotGroupByTabId.get(tabId)
    const target =
      [
        groupIdByEditorId.get(tabId),
        groupIdByWrapperId.get(tabId),
        snapshotGroup?.id,
        snapshot.activeGroupId,
        session.activeGroupIdByWorktree?.[worktreeId]
      ]
        .map((groupId) => (groupId ? groups.find((group) => group.id === groupId) : undefined))
        .find((group) => group !== undefined) ?? groups[0]!
    target.tabOrder = insertByPersistedOrder(target.tabOrder, tabId, snapshotGroup?.tabOrder)
  }
  const repaired = repairMobileSessionTabGroupsAfterRetirement(groups, present) ?? [
    { ...groups[0]!, activeTabId: null, tabOrder: [] }
  ]
  const liveGroupIds = new Set(repaired.map((group) => group.id))
  const layout =
    repaired.length > 1
      ? (pruneTabGroupLayoutAfterRetirement(session.tabGroupLayouts?.[worktreeId], liveGroupIds) ??
        pruneTabGroupLayoutAfterRetirement(snapshot.tabGroupLayout ?? undefined, liveGroupIds))
      : undefined
  return { groups: repaired, layout }
}

/** A legacy session has no window groups: editors join the snapshot's groups by persisted position. */
function placeEditorsInSnapshotGroups(
  snapshot: RuntimeMobileSessionTabsSnapshot,
  baseTabs: readonly RuntimeMobileSessionSnapshotTab[],
  editors: readonly HostEditorMobileTab[],
  session: WorkspaceSessionState | null,
  previousEditorIds: ReadonlySet<string>
): RuntimeMobileSessionTabGroup[] {
  const worktreeId = snapshot.worktree
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
  for (const editor of editors) {
    const alreadyPlaced = groups.find((group) => group.tabOrder.includes(editor.tab.id))
    if (alreadyPlaced) {
      continue
    }
    const target =
      groups.find((group) => group.id === editor.groupId) ??
      groups.find((group) => group.id === snapshot.activeGroupId) ??
      groups[0]!
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
  return groups.filter((group, index) => group.tabOrder.length > 0 || index === 0)
}

/**
 * Replaces a headless snapshot's editor tabs with the host's current editor tabs, placing each in
 * its persisted group and position. Re-derived on every hydrate, so a closed tab cannot come back.
 */
export function overlayHostEditorTabs(
  snapshot: RuntimeMobileSessionTabsSnapshot,
  editors: readonly HostEditorMobileTab[],
  session: WorkspaceSessionState | null,
  focus: HostEditorFocus = {}
): RuntimeMobileSessionTabsSnapshot {
  const baseTabs = snapshot.tabs.filter((tab) => !isEditorSnapshotTab(tab))
  const previousEditorIds = new Set(snapshot.tabs.filter(isEditorSnapshotTab).map((tab) => tab.id))
  if (editors.length === 0 && previousEditorIds.size === 0) {
    // Why: a worktree with no editor tabs keeps the terminal-only projection untouched.
    return snapshot
  }
  const projected =
    session && isUnifiedWorkspaceSession(session) && editors.length > 0
      ? projectPersistedTabGroups(snapshot, baseTabs, editors, session)
      : null
  let groups =
    projected?.groups ??
    placeEditorsInSnapshotGroups(snapshot, baseTabs, editors, session, previousEditorIds)

  const candidateTabs = [...baseTabs, ...editors.map((editor) => editor.tab)]
  const activeTabId = pickActiveTabId(snapshot, candidateTabs, editors, session, focus, groups)
  const nextTabs = candidateTabs.map((tab) =>
    isEditorSnapshotTab(tab) || tab.id === activeTabId || tab.isActive
      ? { ...tab, isActive: tab.id === activeTabId }
      : tab
  )
  const activeTab = nextTabs.find((tab) => tab.id === activeTabId) ?? null
  const activeTopLevelId = activeTab ? topLevelTabId(activeTab) : null
  const activeGroup = activeTopLevelId
    ? groups.find((group) => group.tabOrder.includes(activeTopLevelId))
    : undefined
  groups = groups.map((group) => {
    if (group === activeGroup && activeTopLevelId) {
      return { ...group, activeTabId: activeTopLevelId }
    }
    return group.activeTabId ? group : { ...group, activeTabId: group.tabOrder[0] ?? null }
  })
  const { tabGroupLayout: previousLayout, ...rest } = snapshot
  const tabGroupLayout = projected ? projected.layout : previousLayout
  return {
    ...rest,
    ...(tabGroupLayout ? { tabGroupLayout } : {}),
    activeGroupId:
      activeGroup?.id ??
      (groups.some((group) => group.id === snapshot.activeGroupId)
        ? snapshot.activeGroupId
        : (groups[0]?.id ?? null)),
    activeTabId: activeTab?.id ?? null,
    activeTabType: activeTab?.type ?? null,
    tabGroups: groups,
    tabs: nextTabs
  }
}

function topLevelTabId(tab: RuntimeMobileSessionSnapshotTab): string {
  return tab.type === 'terminal' ? tab.parentTabId : tab.id
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

/** The surface a top-level id names: itself, or the active pane of a terminal tab. */
function findTopLevelSurface(
  tabs: readonly RuntimeMobileSessionSnapshotTab[],
  topLevelId: string | null | undefined
): RuntimeMobileSessionSnapshotTab | undefined {
  if (!topLevelId) {
    return undefined
  }
  const surfaces = tabs.filter((tab) => topLevelTabId(tab) === topLevelId)
  return surfaces.find((tab) => tab.isActive) ?? surfaces[0]
}

/**
 * Focus order: an explicit host focus, then whatever the snapshot already shows (so a later
 * terminal activation is not overridden), then the persisted editor focus a restart restores,
 * then the active group's most recent tab, as a window does after its focused tab closes.
 */
function pickActiveTabId(
  snapshot: RuntimeMobileSessionTabsSnapshot,
  candidateTabs: readonly RuntimeMobileSessionSnapshotTab[],
  editors: readonly HostEditorMobileTab[],
  session: WorkspaceSessionState | null,
  focus: HostEditorFocus,
  groups: readonly RuntimeMobileSessionTabGroup[]
): string | null {
  const nextTabIds = new Set(candidateTabs.map((tab) => tab.id))
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
  const activeGroup =
    groups.find((group) => group.id === snapshot.activeGroupId) ??
    groups.find((group) => group.id === session?.activeGroupIdByWorktree?.[snapshot.worktree]) ??
    groups[0]
  return (
    (
      findTopLevelSurface(candidateTabs, activeGroup?.activeTabId) ??
      findTopLevelSurface(candidateTabs, session?.activeTabIdByWorktree?.[snapshot.worktree]) ??
      candidateTabs[0]
    )?.id ?? null
  )
}
