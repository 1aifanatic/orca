import type { PersistedState } from '../../../shared/persisted-state-types'
import type { SshRemotePtyLease } from '../../../shared/ssh-types'
import {
  terminalLeafMovePaneKeys,
  type TerminalLeafMoveRequest,
  type TerminalLeafMoveResult
} from '../../../shared/terminal-leaf-move'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../shared/terminal-tab-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { retireLeavesFromTerminalLayout } from '../../runtime/mobile-session-terminal-retirement'
import { createMinimalPersistedTerminalTab } from '../restoring-sessions/session-owner-fields'
import { layoutContainsLeafId } from '../restoring-sessions/terminal-layout-normalization'
import { advanceTerminalTopologyRevision } from './terminal-topology-membership'

type PlannedTerminalLeafMove = {
  result: TerminalLeafMoveResult
  session: WorkspaceSessionState | null
}

function moveRecordKey<T>(
  record: Record<string, T> | undefined,
  fromKey: string,
  toKey: string | null,
  remap: (value: T) => T = (value) => value
): Record<string, T> | undefined {
  if (!record || !Object.hasOwn(record, fromKey)) {
    return record
  }
  const next = { ...record }
  const value = next[fromKey]
  delete next[fromKey]
  if (toKey !== null && value !== undefined) {
    next[toKey] = remap(value)
  }
  return next
}

function liveTabIds(session: WorkspaceSessionState): Set<string> {
  return new Set(
    Object.values(session.tabsByWorktree ?? {}).flatMap((tabs) => tabs.map((tab) => tab.id))
  )
}

function hasTabId(session: WorkspaceSessionState, tabId: string): boolean {
  return (
    liveTabIds(session).has(tabId) || Object.hasOwn(session.terminalLayoutsByTabId ?? {}, tabId)
  )
}

type SourceHolder = {
  session: WorkspaceSessionState
  sourceTab: TerminalTab
  sourceLayout: TerminalLayoutSnapshot
}

function moveLeafInPartition(
  { session, sourceTab, sourceLayout }: SourceHolder,
  request: TerminalLeafMoveRequest,
  ptyId: string | null
): WorkspaceSessionState {
  const { worktreeId, sourceTabId, targetTabId, leafId } = request
  const tabs = session.tabsByWorktree?.[worktreeId] ?? []
  const { from: fromPaneKey, to: toPaneKey } = terminalLeafMovePaneKeys(request)
  const remainingLayout = retireLeavesFromTerminalLayout(sourceLayout, new Set([leafId]))
  const remainingPtyIds = Object.values(remainingLayout?.ptyIdsByLeafId ?? {})
  const { pendingActivationSpawn, ...row } = createMinimalPersistedTerminalTab({
    worktreeId,
    tabId: targetTabId,
    ptyId: ptyId ?? '',
    existingTabCount: tabs.length,
    ...(sourceTab.startupCwd ? { startupCwd: sourceTab.startupCwd } : {})
  })
  const targetTab = {
    ...row,
    ptyId,
    // A moved live pane reattaches; only an unbound one still spawns on activation.
    ...(ptyId ? {} : { pendingActivationSpawn }),
    ...(sourceTab.shellOverride ? { shellOverride: sourceTab.shellOverride } : {})
  }
  const nextTabs = tabs.map((tab) =>
    tab.id === sourceTabId && tab.ptyId === ptyId
      ? { ...tab, ptyId: remainingPtyIds[0] ?? null }
      : tab
  )
  const movedTitle = sourceLayout.titlesByLeafId?.[leafId]
  const terminalLayoutsByTabId = {
    ...session.terminalLayoutsByTabId,
    [targetTabId]: {
      root: { type: 'leaf' as const, leafId },
      activeLeafId: leafId,
      expandedLeafId: null,
      ...(ptyId ? { ptyIdsByLeafId: { [leafId]: ptyId } } : {}),
      ...(movedTitle ? { titlesByLeafId: { [leafId]: movedTitle } } : {}),
      ...(sourceLayout.chatLeafId === leafId ? { chatLeafId: leafId } : {})
    }
  }
  if (remainingLayout) {
    terminalLayoutsByTabId[sourceTabId] = remainingLayout
  } else {
    // Its sibling was never bound here; the sibling's own binding mints the layout again.
    delete terminalLayoutsByTabId[sourceTabId]
  }
  const remoteSessionIdsByTabId = { ...session.remoteSessionIdsByTabId }
  if (ptyId && remoteSessionIdsByTabId[sourceTabId] === ptyId) {
    remoteSessionIdsByTabId[targetTabId] = ptyId
    if (remainingPtyIds[0]) {
      remoteSessionIdsByTabId[sourceTabId] = remainingPtyIds[0]
    } else {
      delete remoteSessionIdsByTabId[sourceTabId]
    }
  }
  return advanceTerminalTopologyRevision(
    {
      ...session,
      tabsByWorktree: { ...session.tabsByWorktree, [worktreeId]: [...nextTabs, targetTab] },
      terminalLayoutsByTabId,
      ...(session.remoteSessionIdsByTabId ? { remoteSessionIdsByTabId } : {}),
      terminalPtyIncarnationsByPaneKey: moveRecordKey(
        session.terminalPtyIncarnationsByPaneKey,
        fromPaneKey,
        toPaneKey
      ),
      sleepingAgentSessionsByPaneKey: moveRecordKey(
        session.sleepingAgentSessionsByPaneKey,
        fromPaneKey,
        toPaneKey,
        (record) => ({ ...record, paneKey: toPaneKey, tabId: targetTabId })
      )
    },
    worktreeId
  )
}

/**
 * Moves one leaf and its binding into a new tab in the worktree's home partition, in a single
 * session write (STA-9259). The leaf id and the PTY are kept; only the tab half of the pane key
 * changes, so every pane-keyed record follows it in this write; a window save carries presentation
 * only and never rebuilds them. `session` is null when nothing changes.
 */
export function planTerminalLeafMove(
  home: WorkspaceSessionState,
  request: TerminalLeafMoveRequest
): PlannedTerminalLeafMove {
  const { worktreeId, sourceTabId, leafId } = request
  const refuse = (
    reason: Extract<TerminalLeafMoveResult, { status: 'refused' }>['reason']
  ): PlannedTerminalLeafMove => ({ result: { status: 'refused', reason }, session: null })
  if (hasTabId(home, request.targetTabId)) {
    return refuse('target_tab_exists')
  }
  // A layout left behind by a removed tab row owns nothing.
  const tabIds = liveTabIds(home)
  const leafElsewhere = Object.entries(home.terminalLayoutsByTabId ?? {}).some(
    ([tabId, layout]) =>
      tabId !== sourceTabId &&
      tabIds.has(tabId) &&
      layoutContainsLeafId(layout?.root ?? null, leafId)
  )
  if (leafElsewhere) {
    return refuse('leaf_in_other_tab')
  }
  const sourceTab = home.tabsByWorktree?.[worktreeId]?.find((tab) => tab.id === sourceTabId)
  const sourceLayout = home.terminalLayoutsByTabId?.[sourceTabId]
  // Main never saw this leaf, so no binding of it can be duplicated here.
  if (!sourceTab || !sourceLayout || !layoutContainsLeafId(sourceLayout.root, leafId)) {
    return { result: { status: 'not_held' }, session: null }
  }
  const boundPtyId = sourceLayout.ptyIdsByLeafId?.[leafId]
  const ptyId = request.ptyId ?? boundPtyId ?? null
  if (boundPtyId && ptyId !== boundPtyId) {
    return refuse('pty_mismatch')
  }
  return {
    result: { status: 'moved', ptyId },
    session: moveLeafInPartition({ session: home, sourceTab, sourceLayout }, request, ptyId)
  }
}

const PANE_KEYED_UI_RECORDS = [
  'acknowledgedAgentsByPaneKey',
  'activityClearedAtByPaneKey',
  'manuallyUnreadTurnsByPaneKey'
] as const

/** Pane-keyed UI marks and SSH lease leaf addresses that must follow a moved leaf. */
export function rekeyMovedLeafProfileRecords(
  state: Pick<PersistedState, 'ui' | 'sshRemotePtyLeases'>,
  move: TerminalLeafMoveRequest
): { ui?: PersistedState['ui']; sshRemotePtyLeases?: SshRemotePtyLease[] } {
  const { from: fromPaneKey, to: toPaneKey } = terminalLeafMovePaneKeys(move)
  const ui = state.ui
  let nextUi: PersistedState['ui'] | undefined
  for (const key of PANE_KEYED_UI_RECORDS) {
    const moved = moveRecordKey(ui?.[key], fromPaneKey, toPaneKey)
    if (ui && moved !== ui[key]) {
      nextUi = { ...(nextUi ?? ui), [key]: moved }
    }
  }
  const leases = state.sshRemotePtyLeases ?? []
  const leasesChanged = leases.some(
    (lease) => lease.tabId === move.sourceTabId && lease.leafId === move.leafId
  )
  return {
    ...(nextUi ? { ui: nextUi } : {}),
    ...(leasesChanged
      ? {
          sshRemotePtyLeases: leases.map((lease) =>
            lease.tabId === move.sourceTabId && lease.leafId === move.leafId
              ? { ...lease, tabId: move.targetTabId }
              : lease
          )
        }
      : {})
  }
}
