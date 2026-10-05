import type { TerminalLeafMoveRequest } from '../../../shared/terminal-leaf-move'
import type { TerminalPaneLayoutNode } from '../../../shared/terminal-tab-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { retireTerminalSurfaceFromPersistence } from '../../runtime/mobile-session-terminal-persistence-retirement'
import {
  collectLayoutLeafIdsInOrder,
  layoutContainsLeafId
} from '../restoring-sessions/terminal-layout-normalization'
import {
  advanceTerminalTopologyRevision,
  isTerminalOwnerPartition,
  type TerminalSessionPartition
} from './terminal-topology-membership'
import {
  moveRecordKey,
  type PlannedTerminalLeafMove,
  type TerminalLeafMoveOrigin
} from './terminal-leaf-move'

function sameLeafIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((leafId, index) => leafId === right[index])
}

/** Re-forms the split the leaf left around its sibling subtree; null when that subtree is gone. */
function restoreLeafSplit(
  node: TerminalPaneLayoutNode,
  split: NonNullable<TerminalLeafMoveOrigin['split']>,
  leaf: TerminalPaneLayoutNode
): TerminalPaneLayoutNode | null {
  if (sameLeafIds(collectLayoutLeafIdsInOrder(node), split.siblingLeafIds)) {
    return {
      type: 'split',
      direction: split.direction,
      ...(split.ratio !== undefined ? { ratio: split.ratio } : {}),
      first: split.leafFirst ? leaf : node,
      second: split.leafFirst ? node : leaf
    }
  }
  if (node.type === 'leaf') {
    return null
  }
  const first = restoreLeafSplit(node.first, split, leaf)
  if (first) {
    return { ...node, first }
  }
  const second = restoreLeafSplit(node.second, split, leaf)
  return second ? { ...node, second } : null
}

function restoredSourceRoot(
  root: TerminalPaneLayoutNode | null | undefined,
  leafId: string,
  origin: TerminalLeafMoveOrigin | undefined
): TerminalPaneLayoutNode {
  const leaf = { type: 'leaf' as const, leafId }
  if (!root) {
    return leaf
  }
  // A renderer save may already have put it back; never add a second copy.
  if (layoutContainsLeafId(root, leafId)) {
    return root
  }
  const restored = origin?.split ? restoreLeafSplit(root, origin.split, leaf) : null
  // The source changed since the move, so its old position no longer exists.
  return restored ?? { type: 'split', direction: 'horizontal', first: root, second: leaf }
}

/** The source tab closed while the move was in flight, so the tab the move created goes too. */
function retireMovedTab(
  session: WorkspaceSessionState,
  request: TerminalLeafMoveRequest
): WorkspaceSessionState {
  const { worktreeId, targetTabId, leafId } = request
  const paneKey = `${targetTabId}:${leafId}`
  const retired = retireTerminalSurfaceFromPersistence(session, {
    worktreeId,
    parentTabId: targetTabId,
    leafId,
    ptyId: session.terminalLayoutsByTabId?.[targetTabId]?.ptyIdsByLeafId?.[leafId] ?? '',
    incarnationId: session.terminalPtyIncarnationsByPaneKey?.[paneKey]
  })
  if (!retired.sleepingAgentSessionsByPaneKey?.[paneKey]) {
    return retired
  }
  const sleepingAgentSessionsByPaneKey = { ...retired.sleepingAgentSessionsByPaneKey }
  delete sleepingAgentSessionsByPaneKey[paneKey]
  return { ...retired, sleepingAgentSessionsByPaneKey }
}

function returnLeafInPartition(
  session: WorkspaceSessionState,
  request: TerminalLeafMoveRequest,
  origin: TerminalLeafMoveOrigin | undefined
): WorkspaceSessionState {
  const { worktreeId, sourceTabId, targetTabId, leafId } = request
  const movedLayout = session.terminalLayoutsByTabId?.[targetTabId]
  const sourceLayout = session.terminalLayoutsByTabId?.[sourceTabId]
  const tabs = session.tabsByWorktree?.[worktreeId] ?? []
  const ptyId = movedLayout?.ptyIdsByLeafId?.[leafId] ?? null
  const terminalLayoutsByTabId = {
    ...session.terminalLayoutsByTabId,
    // A partition whose source held only this leaf kept the tab but no layout.
    [sourceTabId]: {
      ...(sourceLayout ?? { activeLeafId: leafId, expandedLeafId: null }),
      root: restoredSourceRoot(sourceLayout?.root, leafId, origin),
      ...(ptyId ? { ptyIdsByLeafId: { ...sourceLayout?.ptyIdsByLeafId, [leafId]: ptyId } } : {})
    }
  }
  delete terminalLayoutsByTabId[targetTabId]
  const remoteSessionIdsByTabId = { ...session.remoteSessionIdsByTabId }
  delete remoteSessionIdsByTabId[targetTabId]
  // Restore only what the move itself left; a later write to the source wins.
  if (origin && remoteSessionIdsByTabId[sourceTabId] === origin.remoteSessionId.after) {
    if (origin.remoteSessionId.before === undefined) {
      delete remoteSessionIdsByTabId[sourceTabId]
    } else {
      remoteSessionIdsByTabId[sourceTabId] = origin.remoteSessionId.before
    }
  }
  const restoredTabPtyId = (current: string | null): string | null => {
    if (origin) {
      return current === origin.tabPtyId.after ? origin.tabPtyId.before : current
    }
    return current || ptyId
  }
  const fromPaneKey = `${targetTabId}:${leafId}`
  const toPaneKey = `${sourceTabId}:${leafId}`
  return advanceTerminalTopologyRevision(
    {
      ...session,
      tabsByWorktree: {
        ...session.tabsByWorktree,
        [worktreeId]: tabs
          .filter((tab) => tab.id !== targetTabId)
          .map((tab) => {
            if (tab.id !== sourceTabId) {
              return tab
            }
            const restored = restoredTabPtyId(tab.ptyId ?? null)
            return restored === (tab.ptyId ?? null) ? tab : { ...tab, ptyId: restored }
          })
      },
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
        (record) => ({ ...record, paneKey: toPaneKey, tabId: sourceTabId })
      )
    },
    worktreeId
  )
}

/**
 * Puts back a move main committed but the renderer could not apply, so both again hold the leaf in
 * its source tab, where it sat before (`origins` from the move). Only the tab that move created,
 * still holding just that leaf, is undone; where the source tab has closed since, it is retired.
 */
export function planTerminalLeafMoveUndo(
  partitions: readonly TerminalSessionPartition[],
  request: TerminalLeafMoveRequest,
  origins: readonly TerminalLeafMoveOrigin[] = []
): PlannedTerminalLeafMove {
  const { worktreeId, sourceTabId, targetTabId, leafId } = request
  const owners = partitions.filter(({ hostId }) => isTerminalOwnerPartition(hostId))
  // A layout whose tab row is gone owns nothing, as in planTerminalLeafMove.
  const targetLeaves = owners.map(({ session }) =>
    session.tabsByWorktree?.[worktreeId]?.some((tab) => tab.id === targetTabId)
      ? collectLayoutLeafIdsInOrder(session.terminalLayoutsByTabId?.[targetTabId]?.root ?? null)
      : []
  )
  const holders = owners.filter(
    (_, index) => targetLeaves[index].length === 1 && targetLeaves[index][0] === leafId
  )
  // All copies or none, so no partition is left holding the leaf in the other tab.
  if (targetLeaves.some((leaves) => leaves.length > 1 && leaves.includes(leafId))) {
    return { result: { status: 'refused', reason: 'target_changed' }, sessions: [], origins: [] }
  }
  if (holders.length === 0) {
    return { result: { status: 'not_held' }, sessions: [], origins: [] }
  }
  let returned = false
  const sessions = holders.map(({ hostId, session }) => {
    if (!session.tabsByWorktree?.[worktreeId]?.some((tab) => tab.id === sourceTabId)) {
      return { hostId, session: retireMovedTab(session, request) }
    }
    returned = true
    const origin = origins.find((candidate) => candidate.hostId === hostId)
    return { hostId, session: returnLeafInPartition(session, request, origin) }
  })
  const ptyId =
    holders[0]?.session.terminalLayoutsByTabId?.[targetTabId]?.ptyIdsByLeafId?.[leafId] ?? null
  return {
    result: returned ? { status: 'moved', ptyId } : { status: 'retired' },
    sessions,
    origins: []
  }
}
