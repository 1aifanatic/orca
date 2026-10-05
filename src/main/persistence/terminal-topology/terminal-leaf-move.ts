import type { PersistedState } from '../../../shared/persisted-state-types'
import type { SshRemotePtyLease } from '../../../shared/ssh-types'
import {
  terminalLeafMovePaneKeys,
  type TerminalLeafMoveRequest,
  type TerminalLeafMoveResult
} from '../../../shared/terminal-leaf-move'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { retireLeavesFromTerminalLayout } from '../../runtime/mobile-session-terminal-retirement'
import { createMinimalPersistedTerminalTab } from '../restoring-sessions/session-owner-fields'
import {
  collectLayoutLeafIdsInOrder,
  layoutContainsLeafId
} from '../restoring-sessions/terminal-layout-normalization'
import {
  advanceTerminalTopologyRevision,
  isTerminalOwnerPartition,
  type TerminalSessionPartition
} from './terminal-topology-membership'

export type PlannedTerminalLeafMove = {
  result: TerminalLeafMoveResult
  /** Every partition the plan rewrote; empty when nothing changes. */
  sessions: TerminalSessionPartition[]
}

export function moveRecordKey<T>(
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

function holdsInTab(
  session: WorkspaceSessionState,
  worktreeId: string,
  tabId: string,
  leafId: string
) {
  return (
    Boolean(session.tabsByWorktree?.[worktreeId]?.some((tab) => tab.id === tabId)) &&
    layoutContainsLeafId(session.terminalLayoutsByTabId?.[tabId]?.root ?? null, leafId)
  )
}

function moveLeafInPartition(
  session: WorkspaceSessionState,
  request: TerminalLeafMoveRequest,
  ptyId: string | null
): WorkspaceSessionState | null {
  const { worktreeId, sourceTabId, targetTabId, leafId } = request
  const sourceLayout = session.terminalLayoutsByTabId?.[sourceTabId]
  const tabs = session.tabsByWorktree?.[worktreeId] ?? []
  const sourceTab = tabs.find((tab) => tab.id === sourceTabId)
  if (!sourceLayout || !sourceTab) {
    return null
  }
  const { from: fromPaneKey, to: toPaneKey } = terminalLeafMovePaneKeys(request)
  const boundHere = sourceLayout.ptyIdsByLeafId?.[leafId]
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
      // A stale copy's incarnation belongs to the PTY it no longer names.
      terminalPtyIncarnationsByPaneKey: moveRecordKey(
        session.terminalPtyIncarnationsByPaneKey,
        fromPaneKey,
        boundHere && boundHere !== ptyId ? null : toPaneKey
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

/** A move main already committed, asked again because its answer was lost. */
function findCommittedMove(
  owners: readonly TerminalSessionPartition[],
  request: TerminalLeafMoveRequest
): TerminalLeafMoveResult | null {
  const { worktreeId, sourceTabId, targetTabId, leafId } = request
  const targets = owners.filter(({ session }) => liveTabIds(session).has(targetTabId))
  const committed =
    targets.length > 0 &&
    targets.every(({ session }) => {
      const leaves = collectLayoutLeafIdsInOrder(
        session.terminalLayoutsByTabId?.[targetTabId]?.root ?? null
      )
      return leaves.length === 1 && leaves[0] === leafId
    }) &&
    !owners.some(({ session }) => holdsInTab(session, worktreeId, sourceTabId, leafId))
  if (!committed) {
    return null
  }
  const ptyId =
    targets[0].session.terminalLayoutsByTabId?.[targetTabId]?.ptyIdsByLeafId?.[leafId] ?? null
  return { status: 'moved', ptyId }
}

/**
 * Moves one leaf and its binding into a new tab in a single session write (STA-9259). The leaf
 * id and the PTY are kept; only the tab half of the pane key changes, so every pane-keyed record
 * follows it here instead of being rebuilt later by a renderer save that main's membership rebase
 * would discard. Every owner partition holding the pane moves together: a relay reattach writes an
 * SSH pane into `local` as well as `ssh:`, and a copy left behind refuses the moved pane's bind.
 * Repeating a committed move answers `moved` again and writes nothing.
 */
export function planTerminalLeafMove(
  partitions: readonly TerminalSessionPartition[],
  request: TerminalLeafMoveRequest
): PlannedTerminalLeafMove {
  const { worktreeId, sourceTabId, leafId } = request
  const refuse = (
    reason: Extract<TerminalLeafMoveResult, { status: 'refused' }>['reason']
  ): PlannedTerminalLeafMove => ({ result: { status: 'refused', reason }, sessions: [] })
  const owners = partitions.filter(({ hostId }) => isTerminalOwnerPartition(hostId))
  const repeated = findCommittedMove(owners, request)
  if (repeated) {
    return { result: repeated, sessions: [] }
  }
  if (partitions.some(({ session }) => hasTabId(session, request.targetTabId))) {
    return refuse('target_tab_exists')
  }
  // A layout left behind by a removed tab row owns nothing.
  const leafElsewhere = owners.some(({ session }) => {
    const tabIds = liveTabIds(session)
    return Object.entries(session.terminalLayoutsByTabId ?? {}).some(
      ([tabId, layout]) =>
        tabId !== sourceTabId &&
        tabIds.has(tabId) &&
        layoutContainsLeafId(layout?.root ?? null, leafId)
    )
  })
  if (leafElsewhere) {
    return refuse('leaf_in_other_tab')
  }
  const holders = owners.filter(({ session }) =>
    holdsInTab(session, worktreeId, sourceTabId, leafId)
  )
  // Main never saw this leaf, so no binding of it can be duplicated here.
  if (holders.length === 0) {
    return { result: { status: 'not_held' }, sessions: [] }
  }
  const boundPtyIds = new Set(
    holders.flatMap(
      ({ session }) => session.terminalLayoutsByTabId?.[sourceTabId]?.ptyIdsByLeafId?.[leafId] ?? []
    )
  )
  // The renderer's live PTY id wins: after an SSH respawn one copy can still name the old PTY.
  const ptyId = request.ptyId ?? (boundPtyIds.size === 1 ? [...boundPtyIds][0] : null)
  if (boundPtyIds.size > 0 && !(ptyId && boundPtyIds.has(ptyId))) {
    return refuse('pty_mismatch')
  }
  return {
    result: { status: 'moved', ptyId },
    sessions: holders.flatMap(({ hostId, session }) => {
      const moved = moveLeafInPartition(session, request, ptyId)
      return moved ? [{ hostId, session: moved }] : []
    })
  }
}

/** Pane-keyed UI marks and SSH lease leaf addresses that must follow a moved leaf. */
export function rekeyMovedLeafProfileRecords(
  state: Pick<PersistedState, 'ui' | 'sshRemotePtyLeases'>,
  move: TerminalLeafMoveRequest
): { ui?: PersistedState['ui']; sshRemotePtyLeases?: SshRemotePtyLease[] } {
  const { from: fromPaneKey, to: toPaneKey } = terminalLeafMovePaneKeys(move)
  const ui = state.ui
  const nextUi = ui
    ? {
        ...ui,
        acknowledgedAgentsByPaneKey: moveRecordKey(
          ui.acknowledgedAgentsByPaneKey,
          fromPaneKey,
          toPaneKey
        ),
        activityClearedAtByPaneKey: moveRecordKey(
          ui.activityClearedAtByPaneKey,
          fromPaneKey,
          toPaneKey
        ),
        manuallyUnreadTurnsByPaneKey: moveRecordKey(
          ui.manuallyUnreadTurnsByPaneKey,
          fromPaneKey,
          toPaneKey
        )
      }
    : undefined
  const uiChanged =
    nextUi !== undefined &&
    (nextUi.acknowledgedAgentsByPaneKey !== ui?.acknowledgedAgentsByPaneKey ||
      nextUi.activityClearedAtByPaneKey !== ui?.activityClearedAtByPaneKey ||
      nextUi.manuallyUnreadTurnsByPaneKey !== ui?.manuallyUnreadTurnsByPaneKey)
  const leases = state.sshRemotePtyLeases ?? []
  const leasesChanged = leases.some(
    (lease) => lease.tabId === move.sourceTabId && lease.leafId === move.leafId
  )
  return {
    ...(uiChanged ? { ui: nextUi } : {}),
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
