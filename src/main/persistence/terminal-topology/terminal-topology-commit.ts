import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../shared/execution-host'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type {
  TerminalLeafMoveRequest,
  TerminalLeafMoveResult
} from '../../../shared/terminal-leaf-move'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { startSpan } from '../../observability/tracer'
import {
  terminalSurfaceCloseMutation,
  type TerminalSurfaceCloseCommit
} from '../../runtime/terminal-surface-close'
import type { DurableProfileStateMutation } from '../loading-store/store-runtime-state'
import { planTerminalLeafMove, rekeyMovedLeafProfileRecords } from './terminal-leaf-move'

/**
 * The commit boundary for class-(a) terminal topology (design §5.1). Today it wraps the explicit
 * close and the pane move; later stages route the remaining writers here, binding in B1-4. Debt: the close transform
 * still lives in runtime/ until B1-8 moves it behind this module.
 */

/** Bindings are not listed: `persistPtyBinding` already records `persistence.pty-binding`. */
type TerminalTopologyCommitKind = 'close_leaf' | 'close_tab' | 'move_leaf'

/** Closes one pane or a whole tab, unchanged, inside the topology span. */
export function closeLeafOrTab(
  commit: TerminalSurfaceCloseCommit
): () => DurableProfileStateMutation<Error | undefined> {
  return traced(
    commit.target.kind === 'pane' ? 'close_leaf' : 'close_tab',
    terminalSurfaceCloseMutation(commit)
  )
}

/**
 * One `persistence.terminal-topology` span per commit, from admission to the in-memory write.
 * Attributes stay low-cardinality: no pane key, PTY id or path.
 */
function traced<T>(
  kind: TerminalTopologyCommitKind,
  mutate: () => DurableProfileStateMutation<T>
): () => DurableProfileStateMutation<T> {
  return () => {
    const span = startSpan('persistence.terminal-topology', {
      attributes: { kind: 'persistence', 'topology.kind': kind }
    })
    try {
      const result = mutate()
      const refusal = refusalReason(result.value)
      if (refusal !== undefined) {
        span.setAttribute('topology.outcome', 'refused')
        // Refusals are fixed reason codes, never ids.
        span.setAttribute('topology.refusal', refusal)
      } else {
        span.setAttribute('topology.outcome', result.persist === false ? 'noop' : 'committed')
      }
      span.end()
      return result
    } catch (error) {
      span.setAttribute('topology.outcome', 'threw')
      span.fail(error instanceof Error ? error : String(error))
      throw error
    }
  }
}

/** A close refuses with an Error, a move with a `refused` result. */
function refusalReason(value: unknown): string | undefined {
  if (value instanceof Error) {
    return value.message
  }
  if (typeof value !== 'object' || value === null || !('status' in value)) {
    return undefined
  }
  return value.status === 'refused' && 'reason' in value ? String(value.reason) : undefined
}

export type TerminalLeafMoveCommitContext = {
  state: Pick<
    PersistedState,
    'workspaceSession' | 'workspaceSessionsByHostId' | 'ui' | 'sshRemotePtyLeases'
  >
  hostIds: () => ExecutionHostId[]
  getSession: (hostId: ExecutionHostId) => WorkspaceSessionState
  markDirty: (
    domain: 'workspaceSession' | 'workspaceSessionsByHostId' | 'ui' | 'sshRemotePtyLeases'
  ) => void
}

/**
 * moveLeaf (design §5.6): moves a leaf and its binding into a new tab in every owner partition,
 * with the pane-keyed records, in one durable mutation.
 */
export function moveLeaf(
  request: TerminalLeafMoveRequest,
  context: TerminalLeafMoveCommitContext
): () => DurableProfileStateMutation<TerminalLeafMoveResult> {
  return traced('move_leaf', () => commitLeafMove(request, context))
}

function commitLeafMove(
  request: TerminalLeafMoveRequest,
  context: TerminalLeafMoveCommitContext
): DurableProfileStateMutation<TerminalLeafMoveResult> {
  const { state } = context
  const planned = planTerminalLeafMove(
    context.hostIds().map((hostId) => ({ hostId, session: context.getSession(hostId) })),
    request
  )
  if (planned.sessions.length === 0) {
    return { value: planned.result, persist: false }
  }
  const priorUi = state.ui
  const priorLeases = state.sshRemotePtyLeases
  // Why a closure: the write and its rollback both assign a partition the way the session sinks do.
  const assignPartition = (hostId: ExecutionHostId, session: WorkspaceSessionState): void => {
    if (hostId === LOCAL_EXECUTION_HOST_ID) {
      state.workspaceSession = session
    } else {
      state.workspaceSessionsByHostId = { ...state.workspaceSessionsByHostId, [hostId]: session }
    }
  }
  const restores = planned.sessions.map(({ hostId, session: next }) => {
    const prior = context.getSession(hostId)
    assignPartition(hostId, next)
    context.markDirty(
      hostId === LOCAL_EXECUTION_HOST_ID ? 'workspaceSession' : 'workspaceSessionsByHostId'
    )
    // A later write already replaced what this move wrote; never rewind it.
    return () => {
      if (context.getSession(hostId) === next) {
        assignPartition(hostId, prior)
      }
    }
  })
  const rekeyed = rekeyMovedLeafProfileRecords(state, request)
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
