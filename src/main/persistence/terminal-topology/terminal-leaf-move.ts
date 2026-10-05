import type { ExecutionHostId } from '../../../shared/execution-host'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type { SshRemotePtyLease } from '../../../shared/ssh-types'
import { isTerminalLeafId } from '../../../shared/stable-pane-id'
import type {
  TerminalLeafMoveRequest,
  TerminalLeafMoveResult
} from '../../../shared/terminal-leaf-move'
import type {
  TerminalPaneLayoutNode,
  TerminalPaneSplitDirection
} from '../../../shared/terminal-tab-types'
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

/** Where a moved leaf sat in one partition, so an undo can put it back exactly (review-2 SF2). */
export type TerminalLeafMoveOrigin = {
  hostId: ExecutionHostId
  /** The split the leaf left; null when it was the source's only pane. */
  split: {
    direction: TerminalPaneSplitDirection
    ratio?: number
    leafFirst: boolean
    siblingLeafIds: string[]
  } | null
  /** Source values before the move and the ones the move left, so an undo restores only its own. */
  tabPtyId: { before: string | null; after: string | null }
  remoteSessionId: { before: string | undefined; after: string | undefined }
}

export type PlannedTerminalLeafMove = {
  result: TerminalLeafMoveResult
  /** Every partition the plan rewrote; empty unless it changed something. */
  sessions: TerminalSessionPartition[]
  origins: TerminalLeafMoveOrigin[]
}

export function moveRecordKey<T>(
  record: Record<string, T> | undefined,
  fromKey: string,
  toKey: string,
  remap: (value: T) => T = (value) => value
): Record<string, T> | undefined {
  if (!record || !Object.hasOwn(record, fromKey)) {
    return record
  }
  const next = { ...record }
  const value = next[fromKey]
  delete next[fromKey]
  if (value !== undefined) {
    next[toKey] = remap(value)
  }
  return next
}

function hasTabId(session: WorkspaceSessionState, tabId: string): boolean {
  return (
    Object.values(session.tabsByWorktree ?? {}).some((tabs) =>
      tabs.some((tab) => tab.id === tabId)
    ) || Object.hasOwn(session.terminalLayoutsByTabId ?? {}, tabId)
  )
}

function findLeafSplit(
  node: TerminalPaneLayoutNode | null,
  leafId: string
): TerminalLeafMoveOrigin['split'] {
  if (!node || node.type === 'leaf') {
    return null
  }
  const sides = [
    [node.first, node.second, true],
    [node.second, node.first, false]
  ] as const
  for (const [child, sibling, leafFirst] of sides) {
    if (child.type === 'leaf' && child.leafId === leafId) {
      return {
        direction: node.direction,
        ...(node.ratio !== undefined ? { ratio: node.ratio } : {}),
        leafFirst,
        siblingLeafIds: collectLayoutLeafIdsInOrder(sibling)
      }
    }
  }
  return findLeafSplit(node.first, leafId) ?? findLeafSplit(node.second, leafId)
}

function moveLeafInPartition(
  { hostId, session }: TerminalSessionPartition,
  request: TerminalLeafMoveRequest,
  ptyId: string | null
): { session: WorkspaceSessionState; origin: TerminalLeafMoveOrigin } | null {
  const { worktreeId, sourceTabId, targetTabId, leafId } = request
  const sourceLayout = session.terminalLayoutsByTabId?.[sourceTabId]
  const tabs = session.tabsByWorktree?.[worktreeId] ?? []
  const sourceTab = tabs.find((tab) => tab.id === sourceTabId)
  if (!sourceLayout || !sourceTab) {
    return null
  }
  const fromPaneKey = `${sourceTabId}:${leafId}`
  const toPaneKey = `${targetTabId}:${leafId}`
  const boundHere = sourceLayout.ptyIdsByLeafId?.[leafId]
  // A stale copy's incarnation belongs to the PTY it no longer names.
  const incarnations = { ...session.terminalPtyIncarnationsByPaneKey }
  if (boundHere && boundHere !== ptyId) {
    delete incarnations[fromPaneKey]
  }
  const remainingLayout = retireLeavesFromTerminalLayout(sourceLayout, new Set([leafId]))
  const remainingPtyIds = Object.values(remainingLayout?.ptyIdsByLeafId ?? {})
  const { pendingActivationSpawn, ...minimalTab } = createMinimalPersistedTerminalTab({
    worktreeId,
    tabId: targetTabId,
    ptyId: ptyId ?? '',
    existingTabCount: tabs.length,
    ...(sourceTab.startupCwd ? { startupCwd: sourceTab.startupCwd } : {})
  })
  const targetTab = {
    ...minimalTab,
    ptyId,
    // A moved live pane reattaches; only an unbound one still spawns on activation.
    ...(ptyId ? {} : { pendingActivationSpawn }),
    ...(sourceTab.shellOverride ? { shellOverride: sourceTab.shellOverride } : {})
  }
  const sourceTabPtyIdMoves = sourceTab.ptyId === ptyId
  const sourceTabPtyId = sourceTabPtyIdMoves ? (remainingPtyIds[0] ?? null) : sourceTab.ptyId
  const nextTabs = tabs.map((tab) =>
    tab.id === sourceTabId && sourceTabPtyIdMoves ? { ...tab, ptyId: sourceTabPtyId } : tab
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
  const sourceRemoteSessionId = remoteSessionIdsByTabId[sourceTabId]
  if (ptyId && sourceRemoteSessionId === ptyId) {
    remoteSessionIdsByTabId[targetTabId] = ptyId
    if (remainingPtyIds[0]) {
      remoteSessionIdsByTabId[sourceTabId] = remainingPtyIds[0]
    } else {
      delete remoteSessionIdsByTabId[sourceTabId]
    }
  }
  const moved = advanceTerminalTopologyRevision(
    {
      ...session,
      tabsByWorktree: { ...session.tabsByWorktree, [worktreeId]: [...nextTabs, targetTab] },
      terminalLayoutsByTabId,
      ...(session.remoteSessionIdsByTabId ? { remoteSessionIdsByTabId } : {}),
      terminalPtyIncarnationsByPaneKey: moveRecordKey(
        session.terminalPtyIncarnationsByPaneKey ? incarnations : undefined,
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
  return {
    session: moved,
    origin: {
      hostId,
      split: findLeafSplit(sourceLayout.root, leafId),
      tabPtyId: { before: sourceTab.ptyId ?? null, after: sourceTabPtyId ?? null },
      remoteSessionId: {
        before: sourceRemoteSessionId,
        after: remoteSessionIdsByTabId[sourceTabId]
      }
    }
  }
}

/**
 * Moves one leaf and its binding into a new tab in a single session write (STA-9259). The leaf
 * id and the PTY are kept; only the tab half of the pane key changes, so every pane-keyed record
 * follows it here instead of being rebuilt later by a renderer save that main's membership rebase
 * would discard. Every owner partition holding the pane moves together: a relay reattach writes an
 * SSH pane into `local` as well as `ssh:`, and a copy left behind refuses the moved pane's bind.
 */
export function planTerminalLeafMove(
  partitions: readonly TerminalSessionPartition[],
  request: TerminalLeafMoveRequest
): PlannedTerminalLeafMove {
  const { worktreeId, sourceTabId, targetTabId, leafId } = request
  const refuse = (
    reason: Extract<TerminalLeafMoveResult, { status: 'refused' }>['reason']
  ): PlannedTerminalLeafMove => ({
    result: { status: 'refused', reason },
    sessions: [],
    origins: []
  })
  if (!isTerminalLeafId(leafId) || sourceTabId === targetTabId) {
    return refuse('invalid_request')
  }
  if (partitions.some(({ session }) => hasTabId(session, targetTabId))) {
    return refuse('target_tab_exists')
  }
  const owners = partitions.filter(({ hostId }) => isTerminalOwnerPartition(hostId))
  const leafElsewhere = owners.some(({ session }) => {
    // A layout left behind by a removed tab row owns nothing (review-2 N1).
    const liveTabIds = new Set(
      Object.values(session.tabsByWorktree ?? {}).flatMap((tabs) => tabs.map((tab) => tab.id))
    )
    return Object.entries(session.terminalLayoutsByTabId ?? {}).some(
      ([tabId, layout]) =>
        tabId !== sourceTabId &&
        liveTabIds.has(tabId) &&
        layoutContainsLeafId(layout?.root ?? null, leafId)
    )
  })
  if (leafElsewhere) {
    return refuse('leaf_in_other_tab')
  }
  const holders = owners.filter(
    ({ session }) =>
      session.tabsByWorktree?.[worktreeId]?.some((tab) => tab.id === sourceTabId) &&
      layoutContainsLeafId(session.terminalLayoutsByTabId?.[sourceTabId]?.root ?? null, leafId)
  )
  // Main never saw this leaf, so no binding of it can be duplicated here.
  if (holders.length === 0) {
    return { result: { status: 'not_held' }, sessions: [], origins: [] }
  }
  const boundPtyIds = new Set(
    holders.flatMap(
      ({ session }) => session.terminalLayoutsByTabId?.[sourceTabId]?.ptyIdsByLeafId?.[leafId] ?? []
    )
  )
  // Copies disagree after an SSH respawn bound one partition before the other caught up; the
  // renderer's live PTY id names the current one, and the stale copy is overwritten.
  const liveMatchesOne = Boolean(request.ptyId && boundPtyIds.has(request.ptyId))
  if (
    (boundPtyIds.size > 1 && !liveMatchesOne) ||
    (request.ptyId && boundPtyIds.size === 1 && !liveMatchesOne)
  ) {
    return refuse('pty_mismatch')
  }
  const ptyId =
    boundPtyIds.size > 1 ? request.ptyId : ([...boundPtyIds][0] ?? request.ptyId ?? null)
  const moves = holders.flatMap((holder) => moveLeafInPartition(holder, request, ptyId) ?? [])
  return {
    result: { status: 'moved', ptyId },
    sessions: moves.map(({ origin, session }) => ({ hostId: origin.hostId, session })),
    origins: moves.map(({ origin }) => origin)
  }
}

/** Pane-keyed UI marks and SSH lease leaf addresses that must follow a moved leaf. */
export function rekeyMovedLeafProfileRecords(
  state: Pick<PersistedState, 'ui' | 'sshRemotePtyLeases'>,
  move: { sourceTabId: string; targetTabId: string; leafId: string }
): { ui?: PersistedState['ui']; sshRemotePtyLeases?: SshRemotePtyLease[] } {
  const fromPaneKey = `${move.sourceTabId}:${move.leafId}`
  const toPaneKey = `${move.targetTabId}:${move.leafId}`
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
