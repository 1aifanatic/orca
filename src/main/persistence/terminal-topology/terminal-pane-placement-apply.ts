import type { TerminalPanePlacement } from '../../../shared/terminal-pane-placement'
import type {
  TerminalPaneLayoutNode,
  TerminalPaneSplitDirection,
  TerminalTab
} from '../../../shared/terminal-tab-types'
import { omitUndefinedValues } from '../../../shared/rpc-contract/ui-update-value-tolerance-params'
import { cloneLayoutNode } from '../restoring-sessions/terminal-layout-normalization'
import { sameTerminalLeafSet } from './terminal-layout-set'

type SplitPlacement = Extract<TerminalPanePlacement, { kind: 'split' }>

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
