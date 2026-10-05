import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../shared/execution-host'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type {
  TerminalLeafMoveRequest,
  TerminalLeafMoveResult
} from '../../../shared/terminal-leaf-move'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import {
  terminalSurfaceCloseMutation,
  type TerminalSurfaceCloseCommit
} from '../../runtime/terminal-surface-close'
import type { DurableProfileStateMutation } from '../loading-store/store-runtime-state'
import { publishWorkspaceSessionPartition } from '../loading-store/workspace-session-partition-publication'
import { planTerminalLeafMove, rekeyMovedLeafProfileRecords } from './terminal-leaf-move'
import type { TerminalLeafMoveOriginLedger } from './terminal-leaf-move-origin-ledger'
import { planTerminalLeafMoveUndo } from './terminal-leaf-move-undo'
import type { TerminalSessionPartition } from './terminal-topology-membership'
import {
  startTerminalTopologyWriteSpan,
  type TerminalTopologyCommitKind
} from './terminal-topology-write-span'

/**
 * The commit boundary for class-(a) terminal topology (design §5.1). Today it wraps the explicit
 * close and the pane move; later stages route the remaining writers here, binding in B1-4. Debt:
 * the close transform still lives in runtime/ until B1-8 moves it behind this module.
 */

/** Closes one pane (close_leaf) or a whole tab (close_tab), unchanged, inside the topology span. */
export function closeLeafOrTab(
  commit: TerminalSurfaceCloseCommit
): () => DurableProfileStateMutation<Error | undefined> {
  return topologyCommitMutation(
    commit.target.kind === 'pane' ? 'close_leaf' : 'close_tab',
    terminalSurfaceCloseMutation(commit),
    // Close refusals are fixed reason codes, never ids.
    (value) => (value instanceof Error ? value.message : undefined)
  )
}

/** Runs one commit inside the topology span; `refusalOf` names a refusal's reason code. */
function topologyCommitMutation<T>(
  kind: TerminalTopologyCommitKind,
  mutate: () => DurableProfileStateMutation<T>,
  refusalOf: (value: T) => string | undefined
): () => DurableProfileStateMutation<T> {
  return () => {
    const span = startTerminalTopologyWriteSpan(kind)
    try {
      const result = mutate()
      const refusal = refusalOf(result.value)
      if (refusal !== undefined) {
        span.finish('refused', refusal)
      } else {
        span.finish(result.persist === false ? 'noop' : 'committed')
      }
      return result
    } catch (error) {
      span.finish('threw', error)
      throw error
    }
  }
}

export type TerminalLeafMoveCommitContext = {
  state: Pick<
    PersistedState,
    'workspaceSession' | 'workspaceSessionsByHostId' | 'ui' | 'sshRemotePtyLeases'
  >
  partitions: () => TerminalSessionPartition[]
  getSession: (hostId: ExecutionHostId) => WorkspaceSessionState
  markDirty: (
    domain: 'workspaceSession' | 'workspaceSessionsByHostId' | 'ui' | 'sshRemotePtyLeases'
  ) => void
  origins: TerminalLeafMoveOriginLedger
}

/**
 * moveLeaf (design §5.6): moves a leaf and its binding into a new tab in every owner partition,
 * with the pane-keyed records, in one durable mutation; `undo` puts a committed move back.
 */
export function moveLeaf(
  request: TerminalLeafMoveRequest,
  context: TerminalLeafMoveCommitContext
): () => DurableProfileStateMutation<TerminalLeafMoveResult> {
  return topologyCommitMutation(
    request.undo ? 'undo_move_leaf' : 'move_leaf',
    () => commitLeafMove(request, context),
    (result) => (result.status === 'refused' ? result.reason : undefined)
  )
}

function commitLeafMove(
  request: TerminalLeafMoveRequest,
  context: TerminalLeafMoveCommitContext
): DurableProfileStateMutation<TerminalLeafMoveResult> {
  const { state } = context
  const planned = request.undo
    ? planTerminalLeafMoveUndo(context.partitions(), request, context.origins.take(request))
    : planTerminalLeafMove(context.partitions(), request)
  if (planned.sessions.length === 0) {
    return { value: planned.result, persist: false }
  }
  const priorUi = state.ui
  const priorLeases = state.sshRemotePtyLeases
  const restores = planned.sessions.map(({ hostId, session: next }) => {
    const prior = context.getSession(hostId)
    publishWorkspaceSessionPartition(state, hostId, next)
    context.markDirty(
      hostId === LOCAL_EXECUTION_HOST_ID ? 'workspaceSession' : 'workspaceSessionsByHostId'
    )
    // A later write already replaced what this move wrote; never rewind it.
    return () => {
      if (context.getSession(hostId) === next) {
        publishWorkspaceSessionPartition(state, hostId, prior)
      }
    }
  })
  if (!request.undo) {
    context.origins.remember(request, planned.origins)
  }
  // A retired undo's source tab is closed; its pane-keyed marks would be orphans there.
  const rekeyed =
    planned.result.status === 'retired'
      ? {}
      : rekeyMovedLeafProfileRecords(
          state,
          request.undo
            ? { ...request, sourceTabId: request.targetTabId, targetTabId: request.sourceTabId }
            : request
        )
  if (rekeyed.ui) {
    state.ui = rekeyed.ui
    context.markDirty('ui')
  }
  if (rekeyed.sshRemotePtyLeases) {
    state.sshRemotePtyLeases = rekeyed.sshRemotePtyLeases
    context.markDirty('sshRemotePtyLeases')
  }
  return {
    value: planned.result,
    rollback: () => {
      for (const restore of restores) {
        restore()
      }
      if (rekeyed.ui && state.ui === rekeyed.ui) {
        state.ui = priorUi
      }
      if (rekeyed.sshRemotePtyLeases && state.sshRemotePtyLeases === rekeyed.sshRemotePtyLeases) {
        state.sshRemotePtyLeases = priorLeases
      }
    }
  }
}
