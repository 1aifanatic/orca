import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session-resume'
import { structuralValuesEqual } from '../../../../shared/structural-value-equality'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../../shared/terminal-tab-types'
import type {
  TerminalTopologyLayout,
  TerminalTopologySlice,
  TerminalTopologyTabRow
} from '../../../../shared/terminal-topology-slice'
import { resolvePtyBoundActiveLeafId } from '@/components/terminal-pane/terminal-layout-leaf-ids'
import { sameStringRecord, terminalLayoutNodeEqual } from '@/lib/terminal-layout-equality'
import type { AppState } from '../types'
import { emptyLayoutSnapshot } from '../slices/terminal-helpers'
import type { TerminalSlice, TerminalStoreSet } from './terminal-state'
import { mirrorTerminalUnifiedTabs } from './terminal-topology-mirror-unified-tabs'
import {
  isPendingTerminalTab,
  isRuntimeHostedTab,
  pendingAfterTerminalTopologySlice,
  pendingTerminalLayoutRoot
} from './terminal-pending-panes'

const OPTIONAL_ROW_FIELDS = [
  'launchAgent',
  'defaultTitle',
  'shellOverride',
  'startupCwd',
  'forceHostRuntime',
  'quickCommandLabel'
] as const satisfies readonly (keyof TerminalTopologyTabRow)[]

type _UnmirroredRowField = Exclude<
  keyof TerminalTopologyTabRow,
  'id' | 'ptyId' | 'worktreeId' | 'createdAt' | (typeof OPTIONAL_ROW_FIELDS)[number]
>
void (true satisfies [_UnmirroredRowField] extends [never] ? true : never)

/**
 * Main's row fields replace the window's; presentation stays, and so does `ptyId`. In the window it
 * is the PTY the tab is attached to now (liveness, D1), not main's persisted binding.
 */
function mirrorTabRow(current: TerminalTab, row: TerminalTopologyTabRow): TerminalTab {
  const next: TerminalTab = { ...current, ...row, ptyId: current.ptyId }
  for (const field of OPTIONAL_ROW_FIELDS) {
    if (!(field in row)) {
      delete next[field]
    }
  }
  return structuralValuesEqual(next, current) ? current : next
}

/** A tab main created; its ptyId seeds the window's attachment, as a revealed tab's would. */
function newTabRow(row: TerminalTopologyTabRow, sortOrder: number): TerminalTab {
  return {
    ...row,
    title: row.defaultTitle ?? 'Terminal',
    customTitle: null,
    color: null,
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

function mirrorSleepingRecords(
  current: Record<string, SleepingAgentSessionRecord>,
  slice: TerminalTopologySlice
): Record<string, SleepingAgentSessionRecord> {
  const others = Object.entries(current).filter(
    ([, record]) => record.worktreeId !== slice.worktreeId
  )
  const next = { ...Object.fromEntries(others), ...slice.sleeping }
  return structuralValuesEqual(next, current) ? current : next
}

/**
 * Main's slice replaces the worktree's terminal topology, except tabs still pending here (shown
 * before main names them, or hidden before main drops them); everything else is the window's.
 * Unchanged rows and layouts keep their identity, so an identical slice changes only the seq.
 */
export function mirrorTerminalTopologySlice(
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
    return isRuntimeHostedTab(state, worktreeId, tab.id) || isPending(tab.id, 'add') ? [tab] : []
  })
  const currentIds = new Set(currentTabs.map((tab) => tab.id))
  const added = slice.tabs
    .filter((row) => !currentIds.has(row.id) && !isPending(row.id, 'remove'))
    .map((row, index) => newTabRow(row, kept.length + index))
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

  const sleeping = mirrorSleepingRecords(state.sleepingAgentSessionsByPaneKey, slice)
  return {
    ...(tabsChanged ? { tabsByWorktree: { ...state.tabsByWorktree, [worktreeId]: tabs } } : {}),
    ...(layoutsChanged ? { terminalLayoutsByTabId: layouts } : {}),
    ...(sleeping !== state.sleepingAgentSessionsByPaneKey
      ? { sleepingAgentSessionsByPaneKey: sleeping }
      : {}),
    ...mirrorTerminalUnifiedTabs(state, worktreeId, added, removedIds),
    ...(pending !== state.pendingTerminalPanes ? { pendingTerminalPanes: pending } : {}),
    terminalTopologySeqByWorktree: {
      ...state.terminalTopologySeqByWorktree,
      [worktreeId]: slice.publishSeq
    }
  }
}

export function createTerminalTopologyMirrorActions(
  set: TerminalStoreSet
): Pick<TerminalSlice, 'applyTerminalTopologySlice'> {
  return {
    applyTerminalTopologySlice: (slice) => {
      set((s) =>
        // Pushes and the startup pull race; the higher publishSeq is the newer slice.
        slice.publishSeq > (s.terminalTopologySeqByWorktree[slice.worktreeId] ?? 0)
          ? mirrorTerminalTopologySlice(s, slice)
          : s
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
  const applied = (): boolean =>
    publishSeq === undefined ||
    (getState().terminalTopologySeqByWorktree[worktreeId] ?? 0) >= publishSeq
  return new Promise((resolve) => {
    if (applied()) {
      resolve()
      return
    }
    const unsubscribe = subscribe(() => {
      if (applied()) {
        unsubscribe()
        resolve()
      }
    })
  })
}
