import type {
  TerminalLayoutSnapshot,
  TerminalPaneLayoutNode
} from '../../shared/terminal-tab-types'
import { splitLayoutLeaf } from '../persistence/terminal-topology/terminal-pane-placement-apply'

export function terminalLayoutContainsLeaf(
  node: TerminalPaneLayoutNode | null | undefined,
  leafId: string
): boolean {
  if (!node) {
    return false
  }
  return node.type === 'leaf'
    ? node.leafId === leafId
    : terminalLayoutContainsLeaf(node.first, leafId) ||
        terminalLayoutContainsLeaf(node.second, leafId)
}

/**
 * Insert a newly split-off leaf into a terminal tab's persisted layout tree.
 *
 * Why: a headless ("Orca server") split only updated the live session snapshot,
 * never the persisted workspace-session layout, so a later snapshot rebuild
 * re-derived from the stale single-leaf layout and collapsed the split. This
 * builds the durable post-split layout so the split survives rebuilds.
 */
export function buildHeadlessTerminalSplitLayout(
  existing: TerminalLayoutSnapshot | undefined,
  args: {
    leafId: string
    ptyId: string
    splitFromLeafId: string
    direction: 'horizontal' | 'vertical'
  }
): TerminalLayoutSnapshot {
  const removeProvisionalLeaf = (node: TerminalPaneLayoutNode): TerminalPaneLayoutNode | null => {
    if (node.type === 'leaf') {
      return node.leafId === args.leafId ? null : node
    }
    const first = removeProvisionalLeaf(node.first)
    const second = removeProvisionalLeaf(node.second)
    if (!first) {
      return second
    }
    if (!second) {
      return first
    }
    return { ...node, first, second }
  }
  // Why: PTY admission durably binds the leaf (placed, or grafted at the root) before this commit.
  const currentRoot = existing?.root ? removeProvisionalLeaf(existing.root) : null
  const existingRoot: TerminalPaneLayoutNode = currentRoot ?? {
    type: 'leaf',
    leafId: args.splitFromLeafId
  }
  const ptyIdsByLeafId = { ...existing?.ptyIdsByLeafId }
  delete ptyIdsByLeafId[args.leafId]
  return {
    ...existing,
    root: splitLayoutLeaf(existingRoot, args.splitFromLeafId, args.leafId, args.direction),
    activeLeafId: args.leafId,
    expandedLeafId: existing?.expandedLeafId ?? null,
    ptyIdsByLeafId: {
      ...ptyIdsByLeafId,
      [args.leafId]: args.ptyId
    }
  }
}

/** Count the leaves in a layout tree (a split has ≥2; a single pane has 1). */
export function countTerminalLayoutLeaves(node: TerminalPaneLayoutNode | null | undefined): number {
  if (!node) {
    return 0
  }
  if (node.type === 'leaf') {
    return 1
  }
  return countTerminalLayoutLeaves(node.first) + countTerminalLayoutLeaves(node.second)
}
