import { LOCAL_EXECUTION_HOST_ID, normalizeExecutionHostId } from '../../../shared/execution-host'
import type { PersistedState } from '../../../shared/persisted-state-types'
import { groupedBy } from '../../../shared/grouped-by'
import { parseAppSshPtyId } from '../../../shared/ssh-pty-id'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { retireTerminalSurfaceFromPersistence } from '../../runtime/mobile-session-terminal-persistence-retirement'
import {
  collectTerminalLeafOwners,
  isSameTerminal,
  isTerminalOwnerPartition,
  type TerminalLeafOwner,
  type TerminalOwnerConflictReason,
  type TerminalSessionPartition
} from './terminal-owner-invariants'

export type TerminalOwnerRepair = {
  rule: TerminalOwnerConflictReason
  hostId: TerminalLeafOwner['hostId']
  keptPaneKey: string
  droppedPaneKey: string
  action: 'unbound' | 'removed_leaf' | 'removed_tab'
}

const paneKey = (owner: TerminalLeafOwner): string => `${owner.tab.id}:${owner.leafId}`

function hasTab(session: WorkspaceSessionState, owner: TerminalLeafOwner): boolean {
  return (session.tabsByWorktree[owner.worktreeId] ?? []).some((tab) => tab.id === owner.tab.id)
}

function setLeafBinding(
  session: WorkspaceSessionState,
  owner: TerminalLeafOwner,
  binding: { ptyId?: string | undefined; incarnationId?: string | undefined }
): WorkspaceSessionState {
  const layout = session.terminalLayoutsByTabId[owner.tab.id]
  if (!layout) {
    return session
  }
  const ptyIdsByLeafId = { ...layout.ptyIdsByLeafId }
  const terminalPtyIncarnationsByPaneKey = { ...session.terminalPtyIncarnationsByPaneKey }
  delete ptyIdsByLeafId[owner.leafId]
  delete terminalPtyIncarnationsByPaneKey[paneKey(owner)]
  if (binding.ptyId) {
    ptyIdsByLeafId[owner.leafId] = binding.ptyId
  }
  if (binding.ptyId && binding.incarnationId) {
    terminalPtyIncarnationsByPaneKey[paneKey(owner)] = binding.incarnationId
  }
  // The tab row's ptyId mirrors one of its bound leaves.
  const tabPtyId = binding.ptyId ?? Object.values(ptyIdsByLeafId)[0] ?? null
  return {
    ...session,
    tabsByWorktree: {
      ...session.tabsByWorktree,
      [owner.worktreeId]: (session.tabsByWorktree[owner.worktreeId] ?? []).map((tab) =>
        tab.id === owner.tab.id && (binding.ptyId ? !tab.ptyId : tab.ptyId === owner.ptyId)
          ? { ...tab, ptyId: tabPtyId }
          : tab
      )
    },
    terminalLayoutsByTabId: {
      ...session.terminalLayoutsByTabId,
      [owner.tab.id]: { ...layout, ptyIdsByLeafId }
    },
    terminalPtyIncarnationsByPaneKey
  }
}

function retireLeaf(session: WorkspaceSessionState, owner: TerminalLeafOwner) {
  return retireTerminalSurfaceFromPersistence(session, {
    worktreeId: owner.worktreeId,
    parentTabId: owner.tab.id,
    leafId: owner.leafId,
    ptyId: owner.ptyId ?? '',
    ...(owner.incarnationId ? { incarnationId: owner.incarnationId } : {})
  })
}

/** A split, or a recorded focus, means the user worked in the tab. */
function hasUserHistory(session: WorkspaceSessionState, owner: TerminalLeafOwner): boolean {
  const layout = session.terminalLayoutsByTabId[owner.tab.id]
  return (
    layout?.root?.type === 'split' ||
    Object.values(session.unifiedTabs ?? {}).some((tabs) =>
      tabs.some(
        (unified) =>
          unified.contentType === 'terminal' &&
          (unified.entityId === owner.tab.id || unified.id === owner.tab.id) &&
          typeof unified.lastFocusedAt === 'number'
      )
    )
  )
}

/** Relay ids like `pty-1` repeat across relay restarts, so without incarnations they prove nothing. */
function isLegacyRelayIdMatchedByIdAlone(owners: readonly TerminalLeafOwner[]): boolean {
  const relayPtyId = parseAppSshPtyId(owners[0]?.ptyId ?? '')?.relayPtyId
  return (
    relayPtyId !== undefined &&
    /^pty-\d+$/.test(relayPtyId) &&
    owners.some((owner) => owner.incarnationId === undefined)
  )
}

/** Bound leaves grouped by terminal; a group whose incarnations all differ is stale, not shared. */
function groupLeavesByTerminal(owners: readonly TerminalLeafOwner[]): TerminalLeafOwner[][] {
  const bound = owners.filter((owner) => owner.ptyId)
  return [...groupedBy(bound, (owner) => owner.ptyId).values()].filter(
    (group) =>
      group.some((owner, index) => group.slice(index + 1).some((o) => isSameTerminal(owner, o))) &&
      !isLegacyRelayIdMatchedByIdAlone(group)
  )
}

function repairPartition(
  { hostId, session: loaded }: TerminalSessionPartition,
  repairs: TerminalOwnerRepair[]
): WorkspaceSessionState {
  let session = loaded
  const record = (
    rule: TerminalOwnerConflictReason,
    kept: TerminalLeafOwner,
    dropped: TerminalLeafOwner,
    action: TerminalOwnerRepair['action']
  ): void => {
    repairs.push({
      rule,
      hostId,
      keptPaneKey: paneKey(kept),
      droppedPaneKey: paneKey(dropped),
      action
    })
  }
  // One leaf id in two tabs (STA-9259): the newer tab keeps it.
  const owners = collectTerminalLeafOwners({ hostId, session })
  for (const copies of groupedBy(owners, (owner) => owner.leafId).values()) {
    const [kept, ...dropped] = copies.toSorted(
      (a, b) => b.tab.createdAt - a.tab.createdAt || b.order - a.order
    )
    const bound = copies.filter((copy) => copy.ptyId)
    if (kept && dropped.length > 0 && !kept.ptyId && bound.length === 1 && bound[0]) {
      // The older copy held the only binding; the kept copy inherits it rather than losing it.
      session = setLeafBinding(session, kept, bound[0])
    }
    for (const owner of kept ? dropped : []) {
      const retired = retireLeaf(session, owner)
      if (retired !== session) {
        session = retired
        record(
          'leaf_in_other_tab',
          kept,
          owner,
          hasTab(session, owner) ? 'removed_leaf' : 'removed_tab'
        )
      }
    }
  }
  // One terminal on several leaves (same tab, or STA-9417's minted tab): history wins, then age,
  // then tree order. A loser is unbound; its tab goes only if newer, unused and otherwise unbound.
  for (const group of groupLeavesByTerminal(collectTerminalLeafOwners({ hostId, session }))) {
    const history = new Map(group.map((owner) => [owner, hasUserHistory(session, owner)]))
    const [kept, ...dropped] = group.toSorted(
      (a, b) =>
        Number(history.get(b)) - Number(history.get(a)) ||
        a.tab.createdAt - b.tab.createdAt ||
        a.order - b.order
    )
    for (const owner of kept ? dropped : []) {
      const otherBound = Object.entries(
        session.terminalLayoutsByTabId[owner.tab.id]?.ptyIdsByLeafId ?? {}
      ).some(([leafId, ptyId]) => leafId !== owner.leafId && ptyId)
      if (!otherBound && !history.get(owner) && owner.tab.createdAt > kept.tab.createdAt) {
        session = retireLeaf(session, owner)
        record(
          'pty_bound_to_other_leaf',
          kept,
          owner,
          hasTab(session, owner) ? 'removed_leaf' : 'removed_tab'
        )
      } else {
        session = setLeafBinding(session, owner, {})
        record('pty_bound_to_other_leaf', kept, owner, 'unbound')
      }
    }
  }
  return session
}

/**
 * Removes saved breaches of the two invariants, in `local` and each `ssh:` partition. Deterministic
 * and idempotent. Not called on load yet: the binding write only reports breaches. No local-vs-`ssh:`
 * rule: the relay reattach writes SSH panes into `local` every session.
 */
export function repairDuplicateTerminalOwners(
  state: Pick<PersistedState, 'workspaceSession' | 'workspaceSessionsByHostId'>
): Pick<PersistedState, 'workspaceSession' | 'workspaceSessionsByHostId'> & {
  repairs: TerminalOwnerRepair[]
} {
  const repairs: TerminalOwnerRepair[] = []
  const workspaceSession = repairPartition(
    { hostId: LOCAL_EXECUTION_HOST_ID, session: state.workspaceSession },
    repairs
  )
  let workspaceSessionsByHostId = state.workspaceSessionsByHostId
  for (const [key, session] of Object.entries(state.workspaceSessionsByHostId ?? {})) {
    const hostId = normalizeExecutionHostId(key)
    if (!session || !hostId || !isTerminalOwnerPartition(hostId)) {
      continue
    }
    const repaired = repairPartition({ hostId, session }, repairs)
    if (repaired !== session) {
      workspaceSessionsByHostId = { ...workspaceSessionsByHostId, [hostId]: repaired }
    }
  }
  return { workspaceSession, workspaceSessionsByHostId, repairs }
}
