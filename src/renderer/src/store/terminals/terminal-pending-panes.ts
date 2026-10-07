import { parseExecutionHostId } from '../../../../shared/execution-host'
import type { TerminalTopologySlice } from '../../../../shared/terminal-topology-slice'
import { collectLeafIds } from '@/components/terminal-pane/terminal-pane-layout-tree'
import type { AppState } from '../types'
import type { TerminalSlice, TerminalStoreSet } from './terminal-state'

/** A whole tab when `leafId` is absent. */
export type PendingTerminalPaneKey = { worktreeId: string; tabId: string; leafId?: string }

/**
 * A tab or pane this window shows (`add`) or hides (`remove`) before main's topology does. An add
 * stands until a slice names it; a remove until the slice holding main's reply (`publishSeq`).
 */
export type PendingTerminalPane = PendingTerminalPaneKey & {
  change: 'add' | 'remove'
  publishSeq?: number
}

function isSamePane(a: PendingTerminalPaneKey, b: PendingTerminalPaneKey): boolean {
  return a.worktreeId === b.worktreeId && a.tabId === b.tabId && a.leafId === b.leafId
}

/** A newer change to the same tab or pane replaces the older one: a close supersedes its add. */
export function withPendingTerminalPane(
  pending: readonly PendingTerminalPane[],
  entry: PendingTerminalPane
): PendingTerminalPane[] {
  return [...pending.filter((current) => !isSamePane(current, entry)), entry]
}

export function withoutPendingTerminalTab(
  pending: PendingTerminalPane[],
  tabId: string
): PendingTerminalPane[] {
  return pending.some((entry) => entry.tabId === tabId)
    ? pending.filter((entry) => entry.tabId !== tabId)
    : pending
}

export function isPendingTerminalTab(
  pending: readonly PendingTerminalPane[],
  worktreeId: string,
  tabId: string,
  change: PendingTerminalPane['change']
): boolean {
  return pending.some(
    (entry) =>
      entry.worktreeId === worktreeId &&
      entry.tabId === tabId &&
      entry.leafId === undefined &&
      entry.change === change
  )
}

export function pendingTerminalLeafIds(
  pending: readonly PendingTerminalPane[],
  tabId: string,
  change: PendingTerminalPane['change']
): Set<string> {
  return new Set(
    pending.flatMap((entry) =>
      entry.tabId === tabId && entry.leafId && entry.change === change ? [entry.leafId] : []
    )
  )
}

/** Tabs a `runtime:` host publishes share the worktree id but never ride main's slice. */
export function isRuntimeHostedTab(state: AppState, worktreeId: string, tabId: string): boolean {
  const entry = state.unifiedTabsByWorktree[worktreeId]?.find(
    (tab) => tab.contentType === 'terminal' && (tab.entityId === tabId || tab.id === tabId)
  )
  return parseExecutionHostId(entry?.executionHostId)?.kind === 'runtime'
}

/** A pane this window made, which main's layout doesn't name yet, stays until main names it. */
export function markTerminalPaneIfAheadOfMain(
  state: AppState,
  pane: Required<PendingTerminalPaneKey>
): void {
  const named = collectLeafIds(state.terminalLayoutsByTabId[pane.tabId]?.root).includes(pane.leafId)
  if (!named && !isRuntimeHostedTab(state, pane.worktreeId, pane.tabId)) {
    state.markPendingTerminalPane({ ...pane, change: 'add' })
  }
}

/** The entries still pending once `slice` is applied; the same array when it settles none. */
export function pendingAfterTerminalTopologySlice(
  pending: PendingTerminalPane[],
  slice: TerminalTopologySlice
): PendingTerminalPane[] {
  const tabIds = new Set(slice.tabs.map((tab) => tab.id))
  const leafIds = new Set(Object.values(slice.layouts).flatMap(({ root }) => collectLeafIds(root)))
  const settled = (entry: PendingTerminalPane): boolean =>
    entry.worktreeId === slice.worktreeId &&
    (entry.change === 'add'
      ? entry.leafId
        ? leafIds.has(entry.leafId)
        : tabIds.has(entry.tabId)
      : entry.publishSeq !== undefined && entry.publishSeq <= slice.publishSeq)
  return pending.some(settled) ? pending.filter((entry) => !settled(entry)) : pending
}

export function createTerminalPendingPaneActions(
  set: TerminalStoreSet
): Pick<TerminalSlice, 'markPendingTerminalPane' | 'settlePendingTerminalPaneRemoval'> {
  return {
    markPendingTerminalPane: (entry) => {
      set((s) => ({ pendingTerminalPanes: withPendingTerminalPane(s.pendingTerminalPanes, entry) }))
    },
    settlePendingTerminalPaneRemoval: (pane, publishSeq) => {
      set((s) => {
        const entry = s.pendingTerminalPanes.find(
          (candidate) => candidate.change === 'remove' && isSamePane(candidate, pane)
        )
        if (!entry) {
          return s
        }
        // No publishSeq (refused, or no mirror) or one already applied: main's state stands.
        const stands =
          publishSeq === undefined ||
          publishSeq <= (s.terminalTopologySeqByWorktree[pane.worktreeId] ?? 0)
        return {
          pendingTerminalPanes: stands
            ? s.pendingTerminalPanes.filter((candidate) => candidate !== entry)
            : s.pendingTerminalPanes.map((candidate) =>
                candidate === entry ? { ...candidate, publishSeq } : candidate
              )
        }
      })
    }
  }
}
