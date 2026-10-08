import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import { toSshExecutionHostId, type ExecutionHostId } from '../../../shared/execution-host'
import type { PersistedState } from '../../../shared/persisted-state-types'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import { structuralValuesEqual } from '../../../shared/structural-value-equality'
import type {
  TerminalLeafMoveRequest,
  TerminalLeafMoveResult
} from '../../../shared/terminal-leaf-move'
import type {
  TerminalLayoutSetRequest,
  TerminalLayoutSetResult
} from '../../../shared/terminal-layout-set'
import type { TerminalLeafBindRequest } from '../../../shared/terminal-leaf-bind'
import type { TerminalSleepingRecordChanges } from '../../../shared/terminal-topology-slice'
import type {
  WorkspaceSessionPatch,
  WorkspaceSessionState
} from '../../../shared/workspace-session-state-types'
import type { PtyBindingPersistenceOperations } from '../loading-store/pty-binding-persistence'
import { startSpan } from '../../observability/tracer'
import {
  terminalSurfaceCloseMutation,
  type TerminalSurfaceCloseCommit
} from '../../runtime/terminal-surface-close'
import type { DurableProfileStateMutation } from '../loading-store/store-runtime-state'
import type { Store } from '../loading-store/store'
import { planTerminalLeafMove, rekeyMovedLeafProfileRecords } from './terminal-leaf-move'
import { planTerminalLayoutSet } from './terminal-layout-set'
import { assignWorkspaceSessionPartition } from './terminal-topology-membership'

// The commit boundary for terminal layout (tabs, panes, pane-to-PTY bindings, sleeping agents).
// Wraps the close and the pane move; the close transform still lives in runtime/ and other writers
// move here later.

/** Bindings are not listed: `persistPtyBinding` already records `persistence.pty-binding`. */
type TerminalTopologyCommitKind =
  | 'close_leaf'
  | 'close_tab'
  | 'move_leaf'
  | 'set_layout'
  | 'import_peer_topology'

export function closeLeafOrTab(
  commit: TerminalSurfaceCloseCommit
): () => DurableProfileStateMutation<Error | undefined> {
  return traced(
    commit.target.kind === 'pane' ? 'close_leaf' : 'close_tab',
    terminalSurfaceCloseMutation(commit),
    // Refusals are fixed reason codes, never ids.
    (refusal) => refusal?.message
  )
}

/** Moves a leaf, its binding and its pane-keyed records into a new tab in `hostId`, the worktree's home. */
export function moveLeaf(
  request: TerminalLeafMoveRequest,
  hostId: ExecutionHostId,
  context: TerminalTopologyCommitContext
): () => DurableProfileStateMutation<TerminalLeafMoveResult> {
  return traced(
    'move_leaf',
    () => commitLeafMove(request, hostId, context),
    (result) => (result.status === 'refused' ? result.reason : undefined)
  )
}

/** Records a live PTY the window adopted onto a pane main holds, as a reattach: never creates the pane. */
export function bindLeaf(
  bindings: Pick<PtyBindingPersistenceOperations, 'persistPtyBinding'>,
  request: TerminalLeafBindRequest,
  hostId: ExecutionHostId
): Promise<boolean> {
  return bindings.persistPtyBinding(
    { ...request, mayCreate: false, mayReviveRetiredSurface: false, origin: 'reattach' },
    hostId
  )
}

/** Replaces a tab's tree in `hostId`, the worktree's home, with the user's same-pane geometry edit. */
export function setLayout(
  request: TerminalLayoutSetRequest,
  hostId: ExecutionHostId,
  context: TerminalTopologyCommitContext
): () => DurableProfileStateMutation<TerminalLayoutSetResult> {
  return traced(
    'set_layout',
    () => {
      const planned = planTerminalLayoutSet(context.getSession(hostId), request)
      if (!planned.session) {
        return { value: planned.result, persist: false }
      }
      const rollback = writeRestorable(
        () => context.getSession(hostId),
        (value) => context.markDirty(assignWorkspaceSessionPartition(context.state, hostId, value)),
        planned.session
      )
      return { value: planned.result, rollback }
    },
    (result) => (result.status === 'refused' ? result.reason : undefined)
  )
}

/** The agent a tab launched is gone, so the tab stops naming it, in `hostId`, the worktree's home. */
export function clearLaunchAgent(
  store: Pick<Store, 'getWorkspaceSession' | 'patchWorkspaceSession'>,
  request: { worktreeId: string; tabId: string },
  hostId: ExecutionHostId
): void {
  const session = store.getWorkspaceSession(hostId)
  const tabs = session.tabsByWorktree[request.worktreeId] ?? []
  if (!tabs.some((tab) => tab.id === request.tabId && tab.launchAgent !== undefined)) {
    return
  }
  const cleared = tabs.map((tab) =>
    tab.id === request.tabId ? { ...tab, launchAgent: undefined } : tab
  )
  store.patchWorkspaceSession(
    { tabsByWorktree: { ...session.tabsByWorktree, [request.worktreeId]: cleared } },
    hostId
  )
}

/** A window's own sleeping-record changes, each written in its worktree's home partition. */
export function commitSleepingRecords(
  store: Pick<
    Store,
    'getWorkspaceSessionHostIds' | 'getWorkspaceSession' | 'patchWorkspaceSession'
  >,
  changes: TerminalSleepingRecordChanges,
  homeHostId: (worktreeId: string) => ExecutionHostId | null,
  isFenced: (hostId: ExecutionHostId) => boolean
): void {
  for (const hostId of store.getWorkspaceSessionHostIds()) {
    if (isFenced(hostId)) {
      continue
    }
    const isHome = (worktreeId: string): boolean => homeHostId(worktreeId) === hostId
    const session = store.getWorkspaceSession(hostId)
    const next = sleepLeaf(wakeLeaf(session, changes.wake, isHome), changes.sleep, isHome)
    if (next !== session) {
      store.patchWorkspaceSession(
        { sleepingAgentSessionsByPaneKey: next.sleepingAgentSessionsByPaneKey },
        hostId
      )
    }
  }
}

/** A window's pull from an SSH host, written only to that host's partition, its worktrees' home. */
export function importPeerTopology(
  store: Pick<Store, 'patchWorkspaceSession'>,
  targetId: string,
  session: WorkspaceSessionPatch
): void {
  traced(
    'import_peer_topology',
    () => {
      if (Object.keys(session).length === 0) {
        return { value: undefined, persist: false }
      }
      store.patchWorkspaceSession(session, toSshExecutionHostId(targetId))
      return { value: undefined }
    },
    () => undefined
  )()
}

/** A sleeping agent's record lands beside its tab, in its worktree's home partition. */
export function sleepLeaf(
  session: WorkspaceSessionState,
  records: Record<string, SleepingAgentSessionRecord>,
  isHome: (worktreeId: string) => boolean
): WorkspaceSessionState {
  const current = session.sleepingAgentSessionsByPaneKey ?? {}
  const held = Object.entries(records).filter(
    ([paneKey, record]) =>
      isHome(record.worktreeId) &&
      session.tabsByWorktree?.[record.worktreeId]?.some(
        (tab) => tab.id === parsePaneKey(paneKey)?.tabId
      ) &&
      !structuralValuesEqual(current[paneKey], record)
  )
  return held.length > 0
    ? { ...session, sleepingAgentSessionsByPaneKey: { ...current, ...Object.fromEntries(held) } }
    : session
}

/** Drops records from their worktree's home; the stored record names the worktree. */
export function wakeLeaf(
  session: WorkspaceSessionState,
  paneKeys: string[],
  isHome: (worktreeId: string) => boolean
): WorkspaceSessionState {
  const current = session.sleepingAgentSessionsByPaneKey ?? {}
  const woken = new Set(
    paneKeys.filter(
      (paneKey) => Object.hasOwn(current, paneKey) && isHome(current[paneKey].worktreeId)
    )
  )
  if (woken.size === 0) {
    return session
  }
  return {
    ...session,
    sleepingAgentSessionsByPaneKey: Object.fromEntries(
      Object.entries(current).filter(([paneKey]) => !woken.has(paneKey))
    )
  }
}

/**
 * One `persistence.terminal-topology` span per commit, from admission to the in-memory write.
 * Attributes stay low-cardinality: no pane key, PTY id or path; `refusalOf` returns a fixed code.
 */
function traced<T>(
  kind: TerminalTopologyCommitKind,
  mutate: () => DurableProfileStateMutation<T>,
  refusalOf: (value: T) => string | undefined
): () => DurableProfileStateMutation<T> {
  return () => {
    const span = startSpan('persistence.terminal-topology', {
      attributes: { kind: 'persistence', 'topology.kind': kind }
    })
    let result: DurableProfileStateMutation<T>
    // Why only mutate(): `threw` must mean the write failed, never that tracing did.
    try {
      result = mutate()
    } catch (error) {
      span.setAttribute('topology.outcome', 'threw')
      span.fail(error instanceof Error ? error : String(error))
      throw error
    }
    const refusal = refusalOf(result.value)
    if (refusal !== undefined) {
      span.setAttribute('topology.outcome', 'refused')
      span.setAttribute('topology.refusal', refusal)
    } else {
      span.setAttribute('topology.outcome', result.persist === false ? 'noop' : 'committed')
    }
    span.end()
    return result
  }
}

type TopologyState = Pick<
  PersistedState,
  'workspaceSession' | 'workspaceSessionsByHostId' | 'ui' | 'sshRemotePtyLeases'
>

type TerminalTopologyCommitContext = {
  state: TopologyState
  getSession: (hostId: ExecutionHostId) => WorkspaceSessionState
  markDirty: (
    domain: 'workspaceSession' | 'workspaceSessionsByHostId' | 'ui' | 'sshRemotePtyLeases'
  ) => void
}

/** Writes `next`, returning a restore that puts the prior value back unless a later write replaced it. */
function writeRestorable<V>(read: () => V, write: (value: V) => void, next: V): () => void {
  const prior = read()
  write(next)
  return () => {
    if (read() === next) {
      write(prior)
    }
  }
}

function commitLeafMove(
  request: TerminalLeafMoveRequest,
  hostId: ExecutionHostId,
  context: TerminalTopologyCommitContext
): DurableProfileStateMutation<TerminalLeafMoveResult> {
  const { state } = context
  const planned = planTerminalLeafMove(context.getSession(hostId), request)
  if (!planned.session) {
    return { value: planned.result, persist: false }
  }
  const restores = [
    writeRestorable(
      () => context.getSession(hostId),
      (value) => context.markDirty(assignWorkspaceSessionPartition(state, hostId, value)),
      planned.session
    )
  ]
  const rekeyed = rekeyMovedLeafProfileRecords(state, request)
  if (rekeyed.ui) {
    restores.push(
      writeRestorable(
        () => state.ui,
        (ui) => (state.ui = ui),
        rekeyed.ui
      )
    )
    context.markDirty('ui')
  }
  if (rekeyed.sshRemotePtyLeases) {
    restores.push(
      writeRestorable(
        () => state.sshRemotePtyLeases,
        (leases) => (state.sshRemotePtyLeases = leases),
        rekeyed.sshRemotePtyLeases
      )
    )
    context.markDirty('sshRemotePtyLeases')
  }
  return {
    value: planned.result,
    rollback: () => restores.forEach((restore) => restore())
  }
}
