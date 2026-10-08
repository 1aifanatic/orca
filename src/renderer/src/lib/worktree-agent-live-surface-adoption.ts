import { parsePaneKey } from '../../../shared/stable-pane-id'
import { worktreeIdsEqual } from '../../../shared/worktree/id'
import type { useAppStore } from '@/store'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { resolveTerminalTabPtyOwnership } from './terminal-tab-for-pty-id'
import type {
  LiveTerminalSurfaceOwner,
  LiveTerminalSurfaceOwnerIndex
} from './worktree-live-terminal-surface-owners'

export type LiveSurfaceAdoptionStore = Pick<
  ReturnType<typeof useAppStore.getState>,
  | 'createTab'
  | 'ptyIdsByTabId'
  | 'setTabLayout'
  | 'tabsByWorktree'
  | 'terminalLayoutsByTabId'
  | 'updateTabPtyId'
>

function layoutContainsLeaf(
  root: LiveSurfaceAdoptionStore['terminalLayoutsByTabId'][string]['root'],
  leafId: string
): boolean {
  if (!root) {
    return false
  }
  return root.type === 'leaf'
    ? root.leafId === leafId
    : layoutContainsLeaf(root.first, leafId) || layoutContainsLeaf(root.second, leafId)
}

export function bindLivePtyToExactSurface(
  store: LiveSurfaceAdoptionStore,
  worktreeId: string,
  terminal: { paneKey: string; ptyId: string; tabId: string }
): boolean {
  const pane = parsePaneKey(terminal.paneKey)
  if (!pane || pane.tabId !== terminal.tabId) {
    return false
  }
  const ownerEntries = Object.entries(store.tabsByWorktree).flatMap(([ownerWorktreeId, tabs]) =>
    tabs.filter((tab) => tab.id === terminal.tabId).map((tab) => ({ ownerWorktreeId, tab }))
  )
  const competingBinding = Object.entries(store.ptyIdsByTabId).some(
    ([tabId, ptyIds]) => tabId !== terminal.tabId && ptyIds.includes(terminal.ptyId)
  )
  if (ownerEntries.length > 1 || competingBinding) {
    return false
  }
  const existing = ownerEntries[0]
  if (existing) {
    const layout = store.terminalLayoutsByTabId[terminal.tabId]
    if (
      !worktreeIdsEqual(existing.ownerWorktreeId, worktreeId) ||
      !layoutContainsLeaf(layout?.root ?? null, pane.leafId)
    ) {
      return false
    }
    store.updateTabPtyId(terminal.tabId, terminal.ptyId)
    bindLeafInMain(existing.ownerWorktreeId, terminal.tabId, pane.leafId, terminal.ptyId)
    return true
  }
  return mintTabForLivePty(store, worktreeId, terminal.ptyId, {
    tabId: terminal.tabId,
    leafId: pane.leafId
  })
}

/** The pane's binding is main's: it records the adopted PTY, and its push brings it to the pane. */
function bindLeafInMain(worktreeId: string, tabId: string, leafId: string, ptyId: string): void {
  void globalThis.window?.api?.session?.bindTerminalLeaf?.({ worktreeId, tabId, leafId, ptyId })
}

/** A new tab for a live PTY; bound in main at once, so a restart before its pane mounts reattaches. */
function mintTabForLivePty(
  store: LiveSurfaceAdoptionStore,
  worktreeId: string,
  ptyId: string,
  { tabId, leafId }: { tabId?: string; leafId: string }
): boolean {
  const created = store.createTab(worktreeId, undefined, undefined, {
    ...(tabId ? { id: tabId } : {}),
    initialLeafId: leafId,
    initialPtyId: ptyId,
    activate: false,
    recordInteraction: false
  })
  if (tabId && created.id !== tabId) {
    return false
  }
  bindLeafInMain(worktreeId, created.id, leafId, ptyId)
  return true
}

function tabExists(store: LiveSurfaceAdoptionStore, tabId: string): boolean {
  return Object.values(store.tabsByWorktree).some((tabs) => tabs.some((tab) => tab.id === tabId))
}

/**
 * Rebind a PTY the host found unowned to the pane its record names, but only while this renderer
 * still holds that pane free: the host's graph omits unmounted panes, so its verdict cannot tell a
 * closed pane from one that merely lost its binding, and minting forks the PTY onto a second tab.
 */
function bindToRecordedSurface(
  store: LiveSurfaceAdoptionStore,
  worktreeId: string,
  recorded: LiveTerminalSurfaceOwner,
  liveSurfaceOwners: LiveTerminalSurfaceOwnerIndex
): boolean {
  const pane = parsePaneKey(recorded.paneKey)
  if (!pane || !tabExists(store, recorded.tabId)) {
    return false
  }
  const heldPtyId = store.terminalLayoutsByTabId[recorded.tabId]?.ptyIdsByLeafId?.[pane.leafId]
  // Main keeps an exited pane's binding (R17), so only a PTY the host still lists holds the pane.
  if (heldPtyId && heldPtyId !== recorded.ptyId && liveSurfaceOwners.has(heldPtyId)) {
    return false
  }
  return bindLivePtyToExactSurface(store, worktreeId, recorded)
}

/** Bind one host-owned PTY to the surface the host names for it; false when none could be named. */
function adoptHostOwnedSurface(
  getState: () => LiveSurfaceAdoptionStore,
  worktreeId: string,
  owner: LiveTerminalSurfaceOwner,
  materializedTabIds: Set<string>
): boolean {
  const store = getState()
  const known = tabExists(store, owner.tabId)
  if (bindLivePtyToExactSurface(store, worktreeId, owner)) {
    if (!known) {
      materializedTabIds.add(owner.tabId)
    }
    return true
  }
  const pane = parsePaneKey(owner.paneKey)
  // Why: a tab this sweep materialized carries only the one host leaf it was
  // minted with, so the host's later panes need a leaf rather than no surface.
  if (!pane || !materializedTabIds.has(owner.tabId)) {
    return false
  }
  const current = getState()
  const layout = current.terminalLayoutsByTabId[owner.tabId]
  if (!layout?.root) {
    return false
  }
  current.setTabLayout(owner.tabId, {
    ...layout,
    root: {
      type: 'split',
      direction: 'horizontal',
      first: layout.root,
      second: { type: 'leaf', leafId: pane.leafId }
    },
    ptyIdsByLeafId: { ...layout.ptyIdsByLeafId, [pane.leafId]: owner.ptyId }
  })
  current.updateTabPtyId(owner.tabId, owner.ptyId)
  return true
}

/**
 * Give every live workspace PTY the surface that already owns it, minting one
 * only for a PTY proven to have none.
 *
 * `surfaced` is whether any live PTY ends the sweep holding a surface. False means the
 * workspace has live agents but nothing the user can look at — the caller owes them a
 * seeded pane, because failing closed must not also fail silent. `declinedPtyIds` names
 * the live PTYs the sweep left without one, so a decline is diagnosable and not mute.
 */
export async function adoptLiveWorkspacePtySurfaces(
  getState: () => LiveSurfaceAdoptionStore,
  worktreeId: string,
  livePtyIds: readonly string[],
  listSurfaceOwners: (worktreeId: string) => Promise<LiveTerminalSurfaceOwnerIndex | null>
): Promise<{ surfaced: boolean; declinedPtyIds: string[] }> {
  // Why: ptyIdsByTabId holds only panes this renderer mounted, so a tab bound
  // solely in tab.ptyId or the persisted layout used to read as unbound.
  const unbound = livePtyIds.filter(
    (ptyId) => resolveTerminalTabPtyOwnership(getState(), worktreeId, ptyId).kind === 'none'
  )
  let surfaced = unbound.length < livePtyIds.length
  const declinedPtyIds: string[] = []
  if (unbound.length === 0) {
    return { surfaced, declinedPtyIds }
  }
  // An unreadable census lists nothing, so it proves no PTY unowned.
  let surfaceOwners: LiveTerminalSurfaceOwnerIndex
  try {
    surfaceOwners = (await listSurfaceOwners(worktreeId)) ?? new Map()
  } catch {
    surfaceOwners = new Map()
  }
  const materializedTabIds = new Set<string>()
  for (const ptyId of unbound) {
    // Why: a pane can mount while the census is in flight, so the pre-RPC
    // verdict is stale by the time it would authorize a mint.
    if (resolveTerminalTabPtyOwnership(getState(), worktreeId, ptyId).kind !== 'none') {
      surfaced = true
      continue
    }
    const owner = surfaceOwners.get(ptyId)
    // Why: only the execution host can prove a live PTY is unowned, and minting
    // on anything weaker forks a running agent onto a second empty surface.
    if (!owner) {
      declinedPtyIds.push(ptyId)
      continue
    }
    if (!('unowned' in owner)) {
      if (adoptHostOwnedSurface(getState, worktreeId, owner, materializedTabIds)) {
        surfaced = true
      } else {
        declinedPtyIds.push(ptyId)
      }
      continue
    }
    surfaced = true
    if (
      owner.recorded &&
      bindToRecordedSurface(getState(), worktreeId, owner.recorded, surfaceOwners)
    ) {
      continue
    }
    mintTabForLivePty(getState(), worktreeId, ptyId, { leafId: createBrowserUuid() })
  }
  return { surfaced, declinedPtyIds }
}
