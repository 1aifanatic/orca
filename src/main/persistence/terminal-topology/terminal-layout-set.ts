import { isDeepStrictEqual } from 'node:util'
import type {
  TerminalLayoutSetRequest,
  TerminalLayoutSetResult
} from '../../../shared/terminal-layout-set'
import type { TerminalPaneLayoutNode } from '../../../shared/terminal-tab-types'
import { collectLayoutLeafIdsInOrder } from '../restoring-sessions/terminal-layout-normalization'
import {
  isTerminalOwnerPartition,
  type TerminalSessionPartition
} from './terminal-topology-membership'

type PlannedTerminalLayoutSet = {
  result: TerminalLayoutSetResult
  /** Every partition the plan rewrote; empty when nothing changes. */
  sessions: TerminalSessionPartition[]
}

const sortedLeafIds = (root: TerminalPaneLayoutNode | null | undefined): string[] =>
  collectLayoutLeafIdsInOrder(root).sort()

/**
 * Replaces a tab's tree with the window's when it holds exactly the same panes. A geometry edit
 * never adds, removes or moves a pane between tabs; a tree that would is refused, not merged.
 * Every owner partition holding the tab takes it, as a move does.
 */
export function planTerminalLayoutSet(
  partitions: readonly TerminalSessionPartition[],
  { worktreeId, tabId, root }: TerminalLayoutSetRequest
): PlannedTerminalLayoutSet {
  const holders = partitions.flatMap((partition) => {
    const layout = partition.session.terminalLayoutsByTabId?.[tabId]
    const holdsTab =
      isTerminalOwnerPartition(partition.hostId) &&
      partition.session.tabsByWorktree?.[worktreeId]?.some((tab) => tab.id === tabId)
    return holdsTab && layout?.root ? [{ ...partition, layout }] : []
  })
  if (holders.length === 0) {
    return { result: { status: 'refused', reason: 'tab_not_held' }, sessions: [] }
  }
  const leafIds = sortedLeafIds(root)
  if (holders.some(({ layout }) => !isDeepStrictEqual(sortedLeafIds(layout.root), leafIds))) {
    return { result: { status: 'refused', reason: 'leaves_differ' }, sessions: [] }
  }
  return {
    result: { status: 'committed' },
    sessions: holders
      .filter(({ layout }) => !isDeepStrictEqual(layout.root, root))
      .map(({ hostId, session, layout }) => ({
        hostId,
        session: {
          ...session,
          terminalLayoutsByTabId: {
            ...session.terminalLayoutsByTabId,
            [tabId]: { ...layout, root }
          }
        }
      }))
  }
}
