import { randomUUID } from 'node:crypto'
import { buildDiffEditorFileId } from '../../shared/editor-file-identity'
import type { ExecutionHostId } from '../../shared/execution-host'
import { detectLanguage } from '../../shared/language-detect'
import type {
  RuntimeMobileSessionFileTab,
  RuntimeMobileSessionMarkdownTab,
  RuntimeMobileSessionTabsSnapshot
} from '../../shared/runtime-types'
import {
  navigationTargetsClients,
  navigationTargetsHost,
  type RuntimeNavigationTarget
} from '../../shared/runtime-navigation'
import { assertHostEditorAuthority } from './editor-authority'
import { closeHostEditFile, persistHostTabGroupLayout } from './host-editor-session-layout'
import { activateHostEditTab, listHostEditTabs, openHostEditTab } from './host-editor-session-model'
import {
  commitHostEditorSession,
  findHostDiffTab,
  publishHostEditorTabs,
  requireOwnSession,
  type HostEditorTabsRuntime
} from './host-editor-tab-publication'
import { getHostEditorTabState } from './host-editor-tab-state'

export const HOST_EDITOR_DRAFT_CLOSE_REFUSAL =
  'This file has unsaved changes on the computer. Open Orca there to save or discard them.'

function hostShouldFocus(navigation: RuntimeNavigationTarget | undefined): boolean {
  // Why: no target keeps the window's original switch; a caller-only open must not move other clients.
  return navigation === undefined || navigationTargetsHost(navigation)
}

function followClients(
  runtime: HostEditorTabsRuntime,
  worktreeId: string,
  tabId: string,
  navigation: RuntimeNavigationTarget | undefined
): void {
  if (navigation && navigationTargetsClients(navigation)) {
    runtime.applyMobileSessionTabNavigation(
      runtime.getMobileSessionTabsForWorktree(worktreeId),
      tabId,
      navigation
    )
  }
}

export function openHostEditFileTab(
  runtime: HostEditorTabsRuntime,
  args: {
    worktreeId: string
    filePath: string
    relativePath: string
    executionHostId: ExecutionHostId
    navigation?: RuntimeNavigationTarget
  }
): string {
  const result = openHostEditTab(requireOwnSession(runtime, args.worktreeId), {
    worktreeId: args.worktreeId,
    filePath: args.filePath,
    relativePath: args.relativePath,
    language: detectLanguage(args.relativePath),
    executionHostId: args.executionHostId,
    activate: hostShouldFocus(args.navigation),
    now: Date.now(),
    newId: randomUUID
  })
  commitHostEditorSession(runtime, args.worktreeId, result.session)
  publishHostEditorTabs(
    runtime,
    args.worktreeId,
    hostShouldFocus(args.navigation) ? result.record.tabId : undefined
  )
  followClients(runtime, args.worktreeId, result.record.tabId, args.navigation)
  return result.record.tabId
}

export function openHostDiffTab(
  runtime: HostEditorTabsRuntime,
  args: {
    worktreeId: string
    filePath: string
    relativePath: string
    staged: boolean
    executionHostId: ExecutionHostId
    navigation?: RuntimeNavigationTarget
  }
): string {
  assertHostEditorAuthority(runtime)
  const state = getHostEditorTabState(runtime)
  const diffSource = args.staged ? 'staged' : 'unstaged'
  const snapshot = runtime.mobileSessionTabsByWorktree.get(args.worktreeId)
  const added = state.addDiff({
    tabId: randomUUID(),
    fileId: buildDiffEditorFileId(args.worktreeId, diffSource, args.relativePath, undefined),
    worktreeId: args.worktreeId,
    filePath: args.filePath,
    relativePath: args.relativePath,
    diffSource,
    language: detectLanguage(args.relativePath),
    executionHostId: args.executionHostId,
    groupId: snapshot?.activeGroupId ?? null,
    returnFocusTabId: null
  })
  // Why: a diff is transient, so its focus lives only in the snapshot; the session keeps the last durable focus.
  const record = hostShouldFocus(args.navigation)
    ? state.focusDiff(args.worktreeId, added.tabId, snapshot?.activeTabId ?? null)
    : added
  publishHostEditorTabs(
    runtime,
    args.worktreeId,
    hostShouldFocus(args.navigation) ? record.tabId : undefined
  )
  followClients(runtime, args.worktreeId, record.tabId, args.navigation)
  return record.tabId
}

/** Closes a host editor tab; closing never writes the file. */
export function closeHostEditorTab(
  runtime: HostEditorTabsRuntime,
  worktreeId: string,
  tab: RuntimeMobileSessionMarkdownTab | RuntimeMobileSessionFileTab
): void {
  assertHostEditorAuthority(runtime)
  const state = getHostEditorTabState(runtime)
  const diff = findHostDiffTab(runtime, worktreeId, tab.id)
  if (diff) {
    const wasActive = runtime.mobileSessionTabsByWorktree.get(worktreeId)?.activeTabId === tab.id
    state.removeDiff(worktreeId, tab.id)
    publishHostEditorTabs(
      runtime,
      worktreeId,
      wasActive ? (diff.returnFocusTabId ?? undefined) : undefined
    )
    return
  }
  const session = requireOwnSession(runtime, worktreeId)
  const record = listHostEditTabs(session, worktreeId).find(
    (candidate) => candidate.tabId === tab.id
  )
  if (!record) {
    throw new Error('tab_not_found')
  }
  // Why: the host cannot arbitrate a desktop draft (even an empty one); closing would destroy it.
  if (record.file.dirtyDraftContent !== undefined || tab.isDirty) {
    publishHostEditorTabs(runtime, worktreeId)
    throw new Error(HOST_EDITOR_DRAFT_CLOSE_REFUSAL)
  }
  commitHostEditorSession(runtime, worktreeId, closeHostEditFile(session, worktreeId, record))
  publishHostEditorTabs(runtime, worktreeId)
}

export function activateHostEditorTab(
  runtime: HostEditorTabsRuntime,
  worktreeId: string,
  tabId: string
): void {
  const diff = findHostDiffTab(runtime, worktreeId, tabId)
  if (diff) {
    assertHostEditorAuthority(runtime)
    const previous = runtime.mobileSessionTabsByWorktree.get(worktreeId)?.activeTabId ?? null
    getHostEditorTabState(runtime).focusDiff(worktreeId, diff.tabId, previous)
    publishHostEditorTabs(runtime, worktreeId, diff.tabId)
    return
  }
  const session = requireOwnSession(runtime, worktreeId)
  const record = listHostEditTabs(session, worktreeId).find((tab) => tab.tabId === tabId)
  if (!record) {
    return
  }
  commitHostEditorSession(runtime, worktreeId, activateHostEditTab(session, worktreeId, record))
  publishHostEditorTabs(runtime, worktreeId, record.tabId)
}

/** A host-targeted activation of a non-editor tab hands the persisted focus back from editors. */
export function releaseHostEditorFocus(
  runtime: HostEditorTabsRuntime,
  worktreeId: string,
  visibleType: 'terminal' | 'browser' | 'agent-session'
): void {
  const session = runtime.getOwnWorkspaceSessionForWorktree(worktreeId)
  if (session?.activeTabTypeByWorktree?.[worktreeId] !== 'editor') {
    return
  }
  commitHostEditorSession(runtime, worktreeId, {
    ...session,
    activeTabTypeByWorktree: { ...session.activeTabTypeByWorktree, [worktreeId]: visibleType }
  })
}

/** After a headless move/split/reorder, persists groups plus editor placement in one write. */
export function persistHostEditorLayout(
  runtime: HostEditorTabsRuntime,
  worktreeId: string,
  snapshot: RuntimeMobileSessionTabsSnapshot
): void {
  if (!snapshot.tabs.some((tab) => tab.type === 'markdown' || tab.type === 'file')) {
    return
  }
  const groupIdByTabId = new Map<string, string>()
  for (const group of snapshot.tabGroups ?? []) {
    for (const tabId of group.tabOrder) {
      groupIdByTabId.set(tabId, group.id)
    }
  }
  const state = getHostEditorTabState(runtime)
  state.setDiffGroups(worktreeId, groupIdByTabId)
  const session = runtime.getOwnWorkspaceSessionForWorktree(worktreeId)
  if (session) {
    commitHostEditorSession(
      runtime,
      worktreeId,
      persistHostTabGroupLayout(session, worktreeId, {
        groups: snapshot.tabGroups ?? [],
        groupLayout: snapshot.tabGroupLayout,
        activeGroupId: snapshot.activeGroupId,
        transientTabIds: new Set(state.listDiffs(worktreeId).map((diff) => diff.tabId))
      })
    )
  }
}
