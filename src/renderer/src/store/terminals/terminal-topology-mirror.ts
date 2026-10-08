import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session-resume'
import { structuralValuesEqual } from '../../../../shared/structural-value-equality'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../../shared/terminal-tab-types'
import type {
  TerminalTabSavedPresentation,
  TerminalTopologyLayout,
  TerminalTopologySlice,
  TerminalTopologyTabRow
} from '../../../../shared/terminal-topology-slice'
import { withTopologyRow } from '../../../../shared/terminal-topology-tab-row'
import { resolvePtyBoundActiveLeafId } from '@/components/terminal-pane/terminal-layout-leaf-ids'
import { sameStringRecord, terminalLayoutNodeEqual } from '@/lib/terminal-layout-equality'
import type { AppState } from '../types'
import { emptyLayoutSnapshot } from '../slices/terminal-helpers'
import type { TerminalSlice, TerminalStoreSet } from './terminal-state'
import { mirrorTerminalUnifiedTabs } from './terminal-topology-mirror-unified-tabs'
import {
  isPendingTerminalTab,
  isTerminalTabMirroredFromMain,
  pendingAfterTerminalTopologySlice,
  pendingTerminalLayoutRoot,
  terminalStoreReady
} from './terminal-pending-panes'

/**
 * Main's row fields replace the window's; presentation stays, and so does `ptyId`. In the window it
 * is the PTY the tab is attached to now (liveness), not main's persisted binding.
 */
function mirrorTabRow(current: TerminalTab, row: TerminalTopologyTabRow): TerminalTab {
  const next = withTopologyRow(current, { ...row, ptyId: current.ptyId })
  return structuralValuesEqual(next, current) ? current : next
}

/**
 * A tab main created; its ptyId seeds the window's attachment, as a revealed tab's would, and the
 * presentation main saved (a title the creator gave it) is what the window first shows.
 */
function newTabRow(
  row: TerminalTopologyTabRow,
  presentation: TerminalTabSavedPresentation | undefined,
  sortOrder: number
): TerminalTab {
  return {
    ...row,
    title: row.defaultTitle ?? 'Terminal',
    customTitle: presentation?.customTitle ?? null,
    color: presentation?.color ?? null,
    sortOrder
  }
}

function mirrorLayout(
  current: TerminalLayoutSnapshot | undefined,
  layout: TerminalTopologyLayout
): TerminalLayoutSnapshot {
  if (
    current &&
    terminalLayoutNodeEqual(current.root, layout.root) &&
    sameStringRecord(current.ptyIdsByLeafId, layout.ptyIdsByLeafId) &&
    sameStringRecord(current.titlesByLeafId, layout.titlesByLeafId)
  ) {
    return current
  }
  const {
    ptyIdsByLeafId: _ptyIds,
    titlesByLeafId: _titles,
    ...presentation
  } = current ?? emptyLayoutSnapshot()
  const activeLeafId = current
    ? presentation.activeLeafId
    : resolvePtyBoundActiveLeafId({
        root: layout.root,
        activeLeafId: null,
        ptyIdsByLeafId: layout.ptyIdsByLeafId
      })
  return { ...presentation, ...layout, activeLeafId }
}

/** One pass over the window's records for the whole batch, however many worktrees it holds. */
function mirrorSleepingRecords(
  current: Record<string, SleepingAgentSessionRecord>,
  slices: readonly TerminalTopologySlice[]
): Record<string, SleepingAgentSessionRecord> {
  const replaced = new Set(slices.map((slice) => slice.worktreeId))
  const next = Object.fromEntries(
    Object.entries(current).filter(([, record]) => !replaced.has(record.worktreeId))
  )
  for (const slice of slices) {
    Object.assign(next, slice.sleeping)
  }
  return structuralValuesEqual(next, current) ? current : next
}

/**
 * Main's slice replaces the worktree's terminal topology, except tabs still pending here (shown
 * before main names them, or hidden before main drops them); everything else is the window's.
 * Unchanged rows and layouts keep their identity, so an identical slice changes only the seq.
 */
function mirrorTerminalTopologySlice(
  state: AppState,
  slice: TerminalTopologySlice
): Partial<AppState> {
  const { worktreeId } = slice
  const pending = pendingAfterTerminalTopologySlice(state.pendingTerminalPanes, slice)
  const isPending = (tabId: string, change: 'add' | 'remove'): boolean =>
    isPendingTerminalTab(pending, worktreeId, tabId, change)
  const currentTabs = state.tabsByWorktree[worktreeId] ?? []
  const rowById = new Map(slice.tabs.map((row) => [row.id, row]))
  const kept = currentTabs.flatMap((tab) => {
    const row = rowById.get(tab.id)
    if (row) {
      return [mirrorTabRow(tab, row)]
    }
    return !isTerminalTabMirroredFromMain(state, worktreeId, tab.id) || isPending(tab.id, 'add')
      ? [tab]
      : []
  })
  const currentIds = new Set(currentTabs.map((tab) => tab.id))
  const added = slice.tabs
    .filter((row) => !currentIds.has(row.id) && !isPending(row.id, 'remove'))
    .map((row, index) => newTabRow(row, slice.presentation[row.id], kept.length + index))
  const tabs = [...kept, ...added]
  const tabsChanged =
    tabs.length !== currentTabs.length || tabs.some((tab, index) => tab !== currentTabs[index])
  const keptIds = new Set(tabs.map((tab) => tab.id))
  const removedIds = currentTabs.filter((tab) => !keptIds.has(tab.id)).map((tab) => tab.id)

  const layouts = { ...state.terminalLayoutsByTabId }
  for (const [tabId, layout] of Object.entries(slice.layouts)) {
    if (!isPending(tabId, 'remove')) {
      const heldRoot = pendingTerminalLayoutRoot(pending, worktreeId, tabId)
      layouts[tabId] = mirrorLayout(
        layouts[tabId],
        heldRoot ? { ...layout, root: heldRoot } : layout
      )
    }
  }
  for (const tab of added) {
    layouts[tab.id] ??= emptyLayoutSnapshot()
  }
  for (const tabId of removedIds) {
    delete layouts[tabId]
  }
  const layoutsChanged =
    added.length + removedIds.length > 0 ||
    Object.keys(slice.layouts).some(
      (tabId) => layouts[tabId] !== state.terminalLayoutsByTabId[tabId]
    )

  return {
    ...(tabsChanged ? { tabsByWorktree: { ...state.tabsByWorktree, [worktreeId]: tabs } } : {}),
    ...(layoutsChanged ? { terminalLayoutsByTabId: layouts } : {}),
    ...mirrorTerminalUnifiedTabs(state, worktreeId, added, removedIds),
    ...(pending !== state.pendingTerminalPanes ? { pendingTerminalPanes: pending } : {}),
    terminalTopologySeqByWorktree: {
      ...state.terminalTopologySeqByWorktree,
      [worktreeId]: slice.publishSeq
    }
  }
}

function mirrorTerminalTopologySlices(
  state: AppState,
  slices: readonly TerminalTopologySlice[]
): Partial<AppState> {
  let next = state
  for (const slice of slices) {
    next = { ...next, ...mirrorTerminalTopologySlice(next, slice) }
  }
  const sleeping = mirrorSleepingRecords(state.sleepingAgentSessionsByPaneKey, slices)
  return sleeping === state.sleepingAgentSessionsByPaneKey
    ? next
    : { ...next, sleepingAgentSessionsByPaneKey: sleeping }
}

const appliedSeq = (state: AppState, slice: TerminalTopologySlice): number =>
  state.terminalTopologySeqByWorktree[slice.worktreeId] ?? 0

export function createTerminalTopologyMirrorActions(
  set: TerminalStoreSet
): Pick<TerminalSlice, 'applyTerminalTopologySlices' | 'restoreTerminalTopologySlice'> {
  return {
    applyTerminalTopologySlices: (slices) => {
      set((s) => {
        // Pushes and the startup pull race; the higher publishSeq is the newer slice.
        const newer = slices.filter((slice) => slice.publishSeq > appliedSeq(s, slice))
        return newer.length > 0 ? mirrorTerminalTopologySlices(s, newer) : s
      })
    },
    restoreTerminalTopologySlice: (slice) => {
      set((s) =>
        slice.publishSeq >= appliedSeq(s, slice) ? mirrorTerminalTopologySlices(s, [slice]) : s
      )
    }
  }
}

/** Resolves once this window has applied main's topology up to `publishSeq`. */
export function terminalTopologyApplied(
  subscribe: (listener: () => void) => () => void,
  getState: () => Pick<AppState, 'terminalTopologySeqByWorktree'>,
  worktreeId: string,
  publishSeq: number | undefined
): Promise<void> {
  return terminalStoreReady(
    subscribe,
    () =>
      publishSeq === undefined ||
      (getState().terminalTopologySeqByWorktree[worktreeId] ?? 0) >= publishSeq
  )
}
