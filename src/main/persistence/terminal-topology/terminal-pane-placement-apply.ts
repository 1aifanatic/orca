import type { TerminalPanePlacement } from '../../../shared/terminal-pane-placement'
import type {
  TerminalPaneLayoutNode,
  TerminalPaneSplitDirection,
  TerminalTab
} from '../../../shared/terminal-tab-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { isTerminalLeafId } from '../../../shared/stable-pane-id'
import { omitUndefinedValues } from '../../../shared/rpc-contract/ui-update-value-tolerance-params'
import { createMinimalPersistedTerminalTab } from '../restoring-sessions/session-owner-fields'
import {
  cloneLayoutNode,
  layoutContainsLeafId
} from '../restoring-sessions/terminal-layout-normalization'
import { sameTerminalLeafSet } from './terminal-layout-set'

type SplitPlacement = Extract<TerminalPanePlacement, { kind: 'split' }>

export type TerminalPaneToPlace = {
  worktreeId: string
  tabId: string
  /** Absent for a tab created before its first pane. */
  leafId?: string
  startupCwd?: string
}

/**
 * Records a new tab row and leaf, unbound, where `placement` puts them: the creation half of both
 * the window's creation commit and a spawn's binding. Mutates `session`; true when membership changed.
 */
export function placeTerminalPane(
  session: WorkspaceSessionState,
  { worktreeId, tabId, leafId, startupCwd }: TerminalPaneToPlace,
  placement: TerminalPanePlacement | undefined
): boolean {
  let changed = false
  const tabs = session.tabsByWorktree?.[worktreeId]
  if (!tabs?.some((tab) => tab.id === tabId)) {
    changed = true
    const minted = createMinimalPersistedTerminalTab({
      worktreeId,
      tabId,
      ptyId: null,
      existingTabCount: tabs?.length ?? 0,
      ...(startupCwd ? { startupCwd } : {})
    })
    session.tabsByWorktree = {
      ...session.tabsByWorktree,
      [worktreeId]: [...(tabs ?? []), placedTerminalTab(minted, placement)]
    }
    session.activeWorktreeId ??= worktreeId
    session.activeTabId ??= tabId
    session.activeTabIdByWorktree = {
      ...session.activeTabIdByWorktree,
      [worktreeId]: session.activeTabIdByWorktree?.[worktreeId] ?? tabId
    }
  }
  if (leafId === undefined || !isTerminalLeafId(leafId)) {
    return changed
  }
  const layout = session.terminalLayoutsByTabId?.[tabId]
  if (!layout) {
    session.terminalLayoutsByTabId = {
      ...session.terminalLayoutsByTabId,
      [tabId]: { root: { type: 'leaf', leafId }, activeLeafId: leafId, expandedLeafId: null }
    }
    return true
  }
  if (!layout.root) {
    layout.root = { type: 'leaf', leafId }
    layout.activeLeafId = leafId
    layout.expandedLeafId = null
    return true
  }
  if (layoutContainsLeafId(layout.root, leafId)) {
    return changed
  }
  // A sender without placement gets a minimal leaf at the root, so a crash can't strand its pane.
  layout.root =
    placement?.kind === 'split'
      ? placedSplitRoot(layout.root, leafId, placement)
      : {
          type: 'split',
          direction: 'vertical',
          first: cloneLayoutNode(layout.root),
          second: { type: 'leaf', leafId }
        }
  layout.activeLeafId = leafId
  if (layout.expandedLeafId && !layoutContainsLeafId(layout.root, layout.expandedLeafId)) {
    layout.expandedLeafId = null
  }
  return true
}

/**
 * The minted row with the sender's creation fields over it; a field it omits keeps the minted
 * value, except `startupCwd`, which is the window's to set and never the spawn's cwd.
 */
export function placedTerminalTab(
  minted: TerminalTab,
  placement: TerminalPanePlacement | undefined
): TerminalTab {
  if (placement?.kind !== 'new-tab' || !placement.row) {
    return minted
  }
  const { startupCwd: _spawnCwd, ...mintedWithoutCwd } = minted
  return { ...mintedWithoutCwd, ...omitUndefinedValues(placement.row) }
}

/**
 * The root once `leafId` joins it: the sender's tree when it holds exactly today's leaves plus
 * this one (the only way to say before/after or split a subtree), else a split at the parent.
 */
export function placedSplitRoot(
  root: TerminalPaneLayoutNode,
  leafId: string,
  { parentLeafId, direction, ratio, proposedRoot }: SplitPlacement
): TerminalPaneLayoutNode {
  const split = splitLayoutLeaf(root, parentLeafId, leafId, direction, ratio)
  return proposedRoot && sameTerminalLeafSet(proposedRoot, split)
    ? cloneLayoutNode(proposedRoot)
    : split
}

/** Replaces `parentLeafId` with a split whose second child is the new leaf. */
export function splitLayoutLeaf(
  node: TerminalPaneLayoutNode,
  parentLeafId: string,
  leafId: string,
  direction: TerminalPaneSplitDirection,
  ratio?: number
): TerminalPaneLayoutNode {
  if (node.type === 'split') {
    return {
      ...node,
      first: splitLayoutLeaf(node.first, parentLeafId, leafId, direction, ratio),
      second: splitLayoutLeaf(node.second, parentLeafId, leafId, direction, ratio)
    }
  }
  return node.leafId === parentLeafId
    ? {
        type: 'split',
        direction,
        first: node,
        second: { type: 'leaf', leafId },
        ...(ratio !== undefined ? { ratio } : {})
      }
    : node
}
