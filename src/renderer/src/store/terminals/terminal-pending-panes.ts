import { parseExecutionHostId } from '../../../../shared/execution-host'
import type { TerminalPaneLayoutNode, TerminalTab } from '../../../../shared/terminal-tab-types'
import { terminalPanePlacementRow } from '@/lib/terminal-pane-placement-row'
import type { TerminalSurfaceCreateRequest } from '../../../../shared/terminal-surface-create'
import type {
  TerminalTopologyReply,
  TerminalTopologySlice
} from '../../../../shared/terminal-topology-slice'
import { collectLeafIds } from '../../../../shared/terminal-pane-layout-tree'
import { isWebClientLocation } from '@/lib/web-client-location'
import { getExplicitRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import type { AppState } from '../types'
import type { TerminalSlice, TerminalStoreSet } from './terminal-state'

/** A whole tab when `leafId` is absent. */
export type PendingTerminalPaneKey = { worktreeId: string; tabId: string; leafId?: string }

/**
 * A tab or pane this window shows (`add`) or hides (`remove`), or a tab tree it keeps (`layout`,
 * a user's geometry edit), before main's topology does. Each stands until the slice holding main's
 * reply (`publishSeq`); an add also ends once a slice names it. A layout also ends once main's tab
 * has other panes than its tree, apart from panes added here and not yet named, since main
 * refuses it then.
 */
export type PendingTerminalPane = PendingTerminalPaneKey & { publishSeq?: number } & (
    | { change: 'add' | 'remove' }
    | { change: 'layout'; root: TerminalPaneLayoutNode }
  )

type PendingTerminalLayout = Extract<PendingTerminalPane, { change: 'layout' }>

function isSamePane(a: PendingTerminalPaneKey, b: PendingTerminalPaneKey): boolean {
  return a.worktreeId === b.worktreeId && a.tabId === b.tabId && a.leafId === b.leafId
}

/** A newer change to the same tab or pane replaces the older one: a close its add, a drag the
 *  previous drag. A tab's tree and its membership are separate changes. */
export function withPendingTerminalPane(
  pending: readonly PendingTerminalPane[],
  entry: PendingTerminalPane
): PendingTerminalPane[] {
  const isLayout = entry.change === 'layout'
  return [
    ...pending.filter(
      (current) => !isSamePane(current, entry) || (current.change === 'layout') !== isLayout
    ),
    entry
  ]
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

/** The tree a pending gesture keeps over main's for this tab, if any. */
export function pendingTerminalLayoutRoot(
  pending: readonly PendingTerminalPane[],
  worktreeId: string,
  tabId: string
): TerminalPaneLayoutNode | undefined {
  return pending.find(
    (entry): entry is PendingTerminalLayout =>
      entry.change === 'layout' && entry.worktreeId === worktreeId && entry.tabId === tabId
  )?.root
}

const leafSet = (
  root: TerminalPaneLayoutNode | null | undefined,
  except: ReadonlySet<string> = new Set()
): string =>
  collectLeafIds(root)
    .filter((leafId) => !except.has(leafId))
    .sort()
    .join('\n')

/**
 * Main's slices carry only local and SSH worktrees. A web client's tabs and a `runtime:` host's
 * come from the host's snapshot, which never settles a pending entry, so they hold none.
 */
export function isTerminalTabMirroredFromMain(
  state: AppState,
  worktreeId: string,
  tabId: string
): boolean {
  const entry = state.unifiedTabsByWorktree[worktreeId]?.find(
    (tab) => tab.contentType === 'terminal' && (tab.entityId === tabId || tab.id === tabId)
  )
  return (
    !isWebClientLocation() &&
    getExplicitRuntimeEnvironmentIdForWorktree(state, worktreeId) === null &&
    parseExecutionHostId(entry?.executionHostId)?.kind !== 'runtime'
  )
}

/** A creation's pending entry: the tab for a new tab, else the pane. */
function pendingTerminalSurfaceCreate({
  worktreeId,
  tabId,
  leafId,
  placement
}: TerminalSurfaceCreateRequest): PendingTerminalPane {
  return {
    worktreeId,
    tabId,
    ...(placement.kind !== 'new-tab' && leafId ? { leafId } : {}),
    change: 'add'
  }
}

/** A new tab's creation commit, and the entry that shows it here until main's reply. */
export function newTerminalTabCreate(
  tab: TerminalTab,
  leafId: string | undefined
): { request: TerminalSurfaceCreateRequest; entry: PendingTerminalPane } {
  const request: TerminalSurfaceCreateRequest = {
    worktreeId: tab.worktreeId,
    tabId: tab.id,
    ...(leafId ? { leafId } : {}),
    placement: { kind: 'new-tab', row: terminalPanePlacementRow(tab) }
  }
  return { request, entry: pendingTerminalSurfaceCreate(request) }
}

/** Commits a creation this window shows as `entry` into main, unbound; main's reply settles it. */
export function sendTerminalSurfaceCreate(
  store: Pick<TerminalSlice, 'settlePendingTerminalPane'>,
  entry: PendingTerminalPane,
  request: TerminalSurfaceCreateRequest
): void {
  settlePendingTerminalChangeOnReply(store, entry, () =>
    // Why optional: an older preload can linger through an in-place renderer reload.
    globalThis.window?.api?.session?.createTerminalSurface?.(request)
  )
}

/** A pane this window made, which main's layout doesn't name yet, is created there. */
export function commitTerminalPaneIfAheadOfMain(
  state: AppState,
  pane: TerminalSurfaceCreateRequest & { leafId: string }
): void {
  if (
    !collectLeafIds(state.terminalLayoutsByTabId[pane.tabId]?.root).includes(pane.leafId) &&
    isTerminalTabMirroredFromMain(state, pane.worktreeId, pane.tabId)
  ) {
    const entry = pendingTerminalSurfaceCreate(pane)
    state.markPendingTerminalPane(entry)
    sendTerminalSurfaceCreate(state, entry, pane)
  }
}

/** The entries still pending once `slice` is applied; the same array when it settles none. */
export function pendingAfterTerminalTopologySlice(
  pending: PendingTerminalPane[],
  slice: TerminalTopologySlice
): PendingTerminalPane[] {
  const tabIds = new Set(slice.tabs.map((tab) => tab.id))
  const leafIds = new Set(Object.values(slice.layouts).flatMap(({ root }) => collectLeafIds(root)))
  const named = (entry: PendingTerminalPane): boolean =>
    entry.leafId ? leafIds.has(entry.leafId) : tabIds.has(entry.tabId)
  const settled = (entry: PendingTerminalPane): boolean => {
    if (entry.worktreeId !== slice.worktreeId) {
      return false
    }
    if (entry.change === 'add' && named(entry)) {
      return true
    }
    // Panes added here that main hasn't named yet don't make a gesture's tree stale.
    const unnamed = new Set(
      pending.flatMap((other) =>
        other.change === 'add' && other.tabId === entry.tabId && other.leafId && !named(other)
          ? [other.leafId]
          : []
      )
    )
    if (
      entry.change === 'layout' &&
      leafSet(slice.layouts[entry.tabId]?.root) !== leafSet(entry.root, unnamed)
    ) {
      return true
    }
    return entry.publishSeq !== undefined && entry.publishSeq <= slice.publishSeq
  }
  return pending.some(settled) ? pending.filter((entry) => !settled(entry)) : pending
}

/** Resolves once `ready` holds, re-checked after every store change. */
export function terminalStoreReady(
  subscribe: (listener: () => void) => () => void,
  ready: () => boolean
): Promise<void> {
  return new Promise((resolve) => {
    if (ready()) {
      resolve()
      return
    }
    const unsubscribe = subscribe(() => {
      if (ready()) {
        unsubscribe()
        resolve()
      }
    })
  })
}

/** Main refuses a tree naming a pane it hasn't recorded, so a gesture right after a split waits. */
export function terminalTabPanesNamed(
  subscribe: (listener: () => void) => () => void,
  getState: () => Pick<AppState, 'pendingTerminalPanes'>,
  tabId: string
): Promise<void> {
  return terminalStoreReady(
    subscribe,
    () => pendingTerminalLeafIds(getState().pendingTerminalPanes, tabId, 'add').size === 0
  )
}

/**
 * Holds `entry` over main's pushes while `send` commits it in main, until the push holding main's
 * reply is applied. A later change to the same target replaces `entry`; this reply then settles nothing.
 */
export function commitPendingTerminalChange(
  store: Pick<TerminalSlice, 'markPendingTerminalPane' | 'settlePendingTerminalPane'>,
  entry: PendingTerminalPane,
  send: () => Promise<TerminalTopologyReply | undefined> | undefined
): void {
  store.markPendingTerminalPane(entry)
  settlePendingTerminalChangeOnReply(store, entry, send)
}

/** Settles `entry`, which this window already shows, once `send`'s reply names main's push. */
function settlePendingTerminalChangeOnReply(
  store: Pick<TerminalSlice, 'settlePendingTerminalPane'>,
  entry: PendingTerminalPane,
  send: () => Promise<TerminalTopologyReply | undefined> | undefined
): void {
  void Promise.resolve(send()).then(
    (reply) => store.settlePendingTerminalPane(entry, reply?.publishSeq),
    (error: unknown) => {
      console.warn(`[terminal-topology] main did not commit the ${entry.change}`, error)
      store.settlePendingTerminalPane(entry)
    }
  )
}

export function createTerminalPendingPaneActions(
  set: TerminalStoreSet
): Pick<TerminalSlice, 'markPendingTerminalPane' | 'settlePendingTerminalPane'> {
  return {
    markPendingTerminalPane: (entry) => {
      set((s) => ({ pendingTerminalPanes: withPendingTerminalPane(s.pendingTerminalPanes, entry) }))
    },
    settlePendingTerminalPane: (entry, publishSeq) => {
      set((s) => {
        if (!s.pendingTerminalPanes.includes(entry)) {
          return s
        }
        // No publishSeq (refused, or no mirror) or one already applied: main's state stands.
        const stands =
          publishSeq === undefined ||
          publishSeq <= (s.terminalTopologySeqByWorktree[entry.worktreeId] ?? 0)
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
