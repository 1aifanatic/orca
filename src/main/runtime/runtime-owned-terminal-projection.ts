import type { RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'
import type {
  RuntimeMobileSessionTabsSnapshot,
  RuntimeSyncWindowGraph
} from '../../shared/runtime-types'
import { isTerminalLeafId } from '../../shared/stable-pane-id'

export function collectRendererPublishedEmptyTerminalPanes(
  graph: Pick<RuntimeSyncWindowGraph, 'mobileSessionTabs' | 'unchangedMobileSessionWorktrees'>,
  snapshots: ReadonlyMap<string, RuntimeMobileSessionTabsSnapshot>,
  acceptedSnapshots: ReadonlyMap<string, { rendererTabIdentityKeys: ReadonlySet<string> }>
): { emptyPaneWorktrees: Map<string, string>; boundPtyIds: Set<string> } {
  const worktrees = new Set([
    ...(graph.mobileSessionTabs?.map((snapshot) => snapshot.worktree) ?? []),
    ...(graph.unchangedMobileSessionWorktrees ?? [])
  ])
  const emptyPaneWorktrees = new Map<string, string>()
  const boundPtyIds = new Set<string>()
  for (const worktreeId of worktrees) {
    const accepted = acceptedSnapshots.get(worktreeId)
    for (const tab of snapshots.get(worktreeId)?.tabs ?? []) {
      // Host-preserved tabs cannot stand in for a pane the renderer actually published.
      if (
        tab.type !== 'terminal' ||
        !accepted?.rendererTabIdentityKeys.has(`${tab.parentTabId}::${tab.leafId}`)
      ) {
        continue
      }
      if (tab.ptyId) {
        boundPtyIds.add(tab.ptyId)
      } else {
        if (isTerminalLeafId(tab.leafId)) {
          emptyPaneWorktrees.set(`${tab.parentTabId}::${tab.leafId}`, worktreeId)
        }
      }
    }
  }
  return { emptyPaneWorktrees, boundPtyIds }
}

export function indexRuntimeOwnedPanePtys(
  ptys: Iterable<RuntimePtyWorktreeRecord>,
  isExited: (ptyId: string) => boolean
): Map<string, RuntimePtyWorktreeRecord | null> {
  const owners = new Map<string, RuntimePtyWorktreeRecord | null>()
  for (const pty of ptys) {
    if (!pty.runtimeSessionOwned || !pty.paneKey || isExited(pty.ptyId)) {
      continue
    }
    // Ambiguous host ownership cannot authorize choosing either process.
    owners.set(pty.paneKey, owners.has(pty.paneKey) ? null : pty)
  }
  return owners
}

export function resolveRetainedRuntimePtyId(
  paneKey: string,
  worktreeId: string,
  tabId: string,
  currentPtyId: string | null,
  incomingPtyIds: ReadonlySet<string>,
  hostOwnedPtys: ReadonlyMap<string, RuntimePtyWorktreeRecord | null>
): string | null {
  const pty = hostOwnedPtys.get(paneKey)
  return pty?.worktreeId === worktreeId &&
    pty.tabId === tabId &&
    (!currentPtyId || currentPtyId === pty.ptyId) &&
    !incomingPtyIds.has(pty.ptyId)
    ? pty.ptyId
    : null
}

export function createRuntimeOwnedPtyResolver(
  ptys: Iterable<RuntimePtyWorktreeRecord>,
  isExited: (ptyId: string) => boolean,
  incomingPtyIds: ReadonlySet<string>
): (
  paneKey: string,
  worktreeId: string,
  tabId: string,
  currentPtyId: string | null
) => string | null {
  const hostOwnedPtys = indexRuntimeOwnedPanePtys(ptys, isExited)
  return (paneKey, worktreeId, tabId, currentPtyId) =>
    resolveRetainedRuntimePtyId(
      paneKey,
      worktreeId,
      tabId,
      currentPtyId,
      incomingPtyIds,
      hostOwnedPtys
    )
}

export function chooseProjectedPtyId(
  incomingPtyId: string | null,
  existingPtyId: string | null | undefined,
  preserveReload: boolean,
  paneKey: string,
  worktreeId: string,
  tabId: string,
  resolver: ReturnType<typeof createRuntimeOwnedPtyResolver>
): string | null {
  const owned = resolver(paneKey, worktreeId, tabId, incomingPtyId)
  return (
    incomingPtyId ??
    (owned && (!existingPtyId || existingPtyId === owned)
      ? owned
      : preserveReload
        ? (existingPtyId ?? null)
        : null)
  )
}

export function shouldPreservePublishedRuntimePane(
  paneKey: string,
  worktreeId: string,
  tabId: string,
  ptyId: string,
  publishedWorktree: string | undefined,
  publishedPtyIds: ReadonlySet<string>,
  resolver: ReturnType<typeof createRuntimeOwnedPtyResolver>
): boolean {
  return (
    publishedWorktree === worktreeId &&
    !publishedPtyIds.has(ptyId) &&
    resolver(paneKey, worktreeId, tabId, ptyId) !== null
  )
}
