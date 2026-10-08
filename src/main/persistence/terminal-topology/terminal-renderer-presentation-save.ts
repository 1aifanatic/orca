import type { ExecutionHostId } from '../../../shared/execution-host'
import type { Tab, TabGroup } from '../../../shared/tab-types'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../shared/terminal-tab-types'
import type {
  WorkspaceSessionPatch,
  WorkspaceSessionState
} from '../../../shared/workspace-session-state-types'
import { withTopologyRow } from '../../../shared/terminal-topology-tab-row'
import { pruneTabGroupLayoutAfterRetirement } from '../../runtime/mobile-session-terminal-retirement'
import { projectTabRow } from '../../runtime/terminal-topology-projection'
import type { Store } from '../loading-store/store'
import { resolveHostId } from '../loading-store/session-host-partitions'
import { sameTerminalLeafSet } from './terminal-layout-set'
import {
  hasHostAuthoritativeTerminalMembership,
  isTerminalOwnerPartition
} from './terminal-topology-membership'

type RendererSaveStore = Pick<
  Store,
  | 'getWorkspaceSession'
  | 'setWorkspaceSession'
  | 'patchWorkspaceSession'
  | 'stageWorkspaceSessionBeforeUnload'
>

// The window's session writes: `session:set`, `session:set-sync`, `session:patch` and the quit stage.
export function setRendererSession(
  store: RendererSaveStore,
  session: WorkspaceSessionState,
  hostId?: string | null
): void {
  store.setWorkspaceSession(overMainTopology(store, session, hostId), hostId)
}

export function patchRendererSession(
  store: RendererSaveStore,
  patch: WorkspaceSessionPatch,
  hostId?: string | null
): void {
  const merged = overMainTopology(store, patch, hostId)
  // A patch carries only the fields it names; main's fields it omits already stand.
  store.patchWorkspaceSession(
    Object.fromEntries(Object.entries(merged).filter(([key]) => Object.hasOwn(patch, key))),
    hostId
  )
}

export function stageRendererSessionBeforeUnload(
  store: RendererSaveStore,
  session: WorkspaceSessionState,
  hostId?: string | null
): void {
  store.stageWorkspaceSessionBeforeUnload(overMainTopology(store, session, hostId), hostId)
}

function overMainTopology<T extends WorkspaceSessionPatch>(
  store: RendererSaveStore,
  incoming: T,
  hostId?: string | null
): T {
  return mergeRendererPresentationSave(
    incoming,
    store.getWorkspaceSession(hostId),
    resolveHostId(hostId)
  )
}

/**
 * A window save brings presentation: titles, colours, order, focus, buffers, tab groups. Main keeps
 * what it authors: which tabs and panes exist, their creation fields, trees and PTY bindings,
 * sleeping records, close records and fences.
 */
export function mergeRendererPresentationSave<T extends WorkspaceSessionPatch>(
  incoming: T,
  prior: WorkspaceSessionState,
  hostId: ExecutionHostId
): T {
  const ownerPartition = isTerminalOwnerPartition(hostId)
  // Another server feeds a `runtime:` partition's rows; main's stand there only for a repo it fenced.
  const mainHolds = (worktreeId: string | undefined): boolean =>
    ownerPartition ||
    (worktreeId !== undefined && hasHostAuthoritativeTerminalMembership(prior, worktreeId))
  return {
    ...incoming,
    clientHostedBrowserPagesByWorktree: prior.clientHostedBrowserPagesByWorktree,
    closedTerminalTabTombstonesByTabId: prior.closedTerminalTabTombstonesByTabId,
    terminalPtyIncarnationsByPaneKey: prior.terminalPtyIncarnationsByPaneKey,
    terminalSurfaceTombstonesByPaneKey: prior.terminalSurfaceTombstonesByPaneKey,
    terminalTopologyRevisionByRepoId: prior.terminalTopologyRevisionByRepoId,
    // Write-once: a payload that omits a mark has not un-applied it.
    defaultTerminalTabsAppliedByWorktreeId: {
      ...prior.defaultTerminalTabsAppliedByWorktreeId,
      ...incoming.defaultTerminalTabsAppliedByWorktreeId
    },
    ...(ownerPartition
      ? { sleepingAgentSessionsByPaneKey: prior.sleepingAgentSessionsByPaneKey }
      : {}),
    ...(incoming.tabsByWorktree && {
      tabsByWorktree: mainRows(incoming.tabsByWorktree, prior, mainHolds)
    }),
    ...(incoming.terminalLayoutsByTabId && {
      terminalLayoutsByTabId: mainLayouts(incoming, prior, mainHolds)
    }),
    ...placementOfMainTabs(incoming, prior, mainHolds)
  }
}

type MainHolds = (worktreeId: string | undefined) => boolean

function mainRows(
  window: WorkspaceSessionState['tabsByWorktree'],
  prior: WorkspaceSessionState,
  mainHolds: MainHolds
): WorkspaceSessionState['tabsByWorktree'] {
  const rows = Object.fromEntries(Object.entries(window).filter(([id]) => !mainHolds(id)))
  for (const [worktreeId, tabs] of Object.entries(prior.tabsByWorktree)) {
    if (mainHolds(worktreeId)) {
      const windowRows = new Map((window[worktreeId] ?? []).map((tab) => [tab.id, tab]))
      rows[worktreeId] = tabs.map((tab) => presentationRow(tab, windowRows.get(tab.id)))
    }
  }
  return rows
}

/**
 * Main's row under the window's presentation. The window's `ptyId` is its live attachment, never
 * main's binding.
 */
function presentationRow(main: TerminalTab, window: TerminalTab | undefined): TerminalTab {
  return window ? withTopologyRow(window, projectTabRow(main)) : main
}

function mainLayouts(
  incoming: WorkspaceSessionPatch,
  prior: WorkspaceSessionState,
  mainHolds: MainHolds
): WorkspaceSessionState['terminalLayoutsByTabId'] {
  const window = incoming.terminalLayoutsByTabId ?? {}
  const worktreeOfTab = new Map<string, string>()
  for (const rows of [prior.tabsByWorktree, incoming.tabsByWorktree ?? {}]) {
    for (const [worktreeId, tabs] of Object.entries(rows)) {
      tabs.forEach((tab) => worktreeOfTab.set(tab.id, worktreeId))
    }
  }
  const layouts = Object.fromEntries(
    Object.entries(window).filter(([tabId]) => !mainHolds(worktreeOfTab.get(tabId)))
  )
  for (const [worktreeId, tabs] of Object.entries(prior.tabsByWorktree)) {
    if (!mainHolds(worktreeId)) {
      continue
    }
    for (const tab of tabs) {
      const main = prior.terminalLayoutsByTabId?.[tab.id]
      if (main) {
        layouts[tab.id] = presentationLayout(main, window[tab.id])
      }
    }
  }
  return layouts
}

/** Per-leaf presentation applies only to the panes main holds; a different pane set is stale. */
function presentationLayout(
  main: TerminalLayoutSnapshot,
  window: TerminalLayoutSnapshot | undefined
): TerminalLayoutSnapshot {
  if (!window || !sameTerminalLeafSet(main.root, window.root)) {
    return main
  }
  return { ...window, root: main.root, ptyIdsByLeafId: main.ptyIdsByLeafId }
}

/** The window's tab bar, holding exactly main's terminal tabs. */
function placementOfMainTabs(
  incoming: WorkspaceSessionPatch,
  prior: WorkspaceSessionState,
  mainHolds: MainHolds
): WorkspaceSessionPatch {
  const unifiedTabs = { ...incoming.unifiedTabs }
  const tabGroups = { ...incoming.tabGroups }
  const tabGroupLayouts = { ...incoming.tabGroupLayouts }
  const activeTabIdByWorktree = { ...incoming.activeTabIdByWorktree }
  const worktreeIds = new Set([
    ...Object.keys(prior.tabsByWorktree),
    ...Object.keys(incoming.tabsByWorktree ?? {})
  ])
  for (const worktreeId of [...worktreeIds].filter(mainHolds)) {
    const mainTabs = prior.tabsByWorktree[worktreeId] ?? []
    const memberIds = new Set(mainTabs.map((tab) => tab.id))
    const unified = incoming.unifiedTabs
      ? memberUnifiedTabs(
          incoming.unifiedTabs[worktreeId] ?? [],
          prior.unifiedTabs?.[worktreeId] ?? [],
          memberIds
        )
      : (prior.unifiedTabs?.[worktreeId] ?? [])
    if (unified.length > 0 || Object.hasOwn(unifiedTabs, worktreeId)) {
      unifiedTabs[worktreeId] = unified
    }
    const validTabIds = new Set([...memberIds, ...unified.map((tab) => tab.id)])
    const groups = groupsOfTabs(
      incoming.tabGroups?.[worktreeId] ?? prior.tabGroups?.[worktreeId] ?? [],
      validTabIds
    )
    if (groups.length > 0 || Object.hasOwn(tabGroups, worktreeId)) {
      tabGroups[worktreeId] = groups
    }
    const groupLayout = pruneTabGroupLayoutAfterRetirement(
      incoming.tabGroupLayouts?.[worktreeId] ?? prior.tabGroupLayouts?.[worktreeId],
      new Set(groups.map((group) => group.id))
    )
    if (groupLayout) {
      tabGroupLayouts[worktreeId] = groupLayout
    } else {
      delete tabGroupLayouts[worktreeId]
    }
    activeTabIdByWorktree[worktreeId] =
      [
        activeTabIdByWorktree[worktreeId],
        prior.activeTabIdByWorktree?.[worktreeId],
        groups[0]?.activeTabId,
        mainTabs[0]?.id
      ].find((tabId) => tabId != null && validTabIds.has(tabId)) ?? null
  }
  return {
    ...(incoming.unifiedTabs && { unifiedTabs }),
    ...(incoming.tabGroups && { tabGroups }),
    ...(incoming.tabGroupLayouts && { tabGroupLayouts }),
    ...(incoming.activeTabIdByWorktree && { activeTabIdByWorktree })
  }
}

/** Terminal entries are a join on main's tabs (by `entityId` or id); other entries are the window's. */
function memberUnifiedTabs(
  window: readonly Tab[],
  main: readonly Tab[],
  memberIds: ReadonlySet<string>
): Tab[] {
  const isMember = (tab: Tab): boolean =>
    tab.contentType === 'terminal' && (memberIds.has(tab.id) || memberIds.has(tab.entityId))
  const kept = window.filter((tab) => tab.contentType !== 'terminal' || isMember(tab))
  const shown = new Set(kept.flatMap((tab) => (isMember(tab) ? [tab.id, tab.entityId] : [])))
  return [
    ...kept,
    ...main.filter((tab) => isMember(tab) && !shown.has(tab.id) && !shown.has(tab.entityId))
  ]
}

function groupsOfTabs(groups: readonly TabGroup[], validTabIds: ReadonlySet<string>): TabGroup[] {
  return groups.flatMap((group) => {
    const tabOrder = group.tabOrder.filter((tabId) => validTabIds.has(tabId))
    if (tabOrder.length === 0) {
      return []
    }
    const activeTabId =
      group.activeTabId && tabOrder.includes(group.activeTabId) ? group.activeTabId : tabOrder[0]
    return [
      {
        ...group,
        tabOrder,
        activeTabId,
        // Assigned even when empty: `...group` would otherwise bring back the unfiltered ids.
        ...(group.recentTabIds && {
          recentTabIds: group.recentTabIds.filter((tabId) => validTabIds.has(tabId))
        })
      }
    ]
  })
}
