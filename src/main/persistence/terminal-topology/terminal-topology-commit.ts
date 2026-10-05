import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../shared/execution-host'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type {
  TerminalLeafMoveRequest,
  TerminalLeafMoveResult
} from '../../../shared/terminal-leaf-move'
import type { TerminalPaneCloseTarget } from '../../../shared/terminal-surface-close-target'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import {
  terminalSurfaceCloseMutation,
  type TerminalSurfaceCloseCommit
} from '../../runtime/terminal-surface-close'
import type { DurableProfileStateMutation } from '../loading-store/store-runtime-state'
import { commitWorkspaceSessionPartition } from '../loading-store/workspace-session-partition-commit'
import { planTerminalLeafMove, rekeyMovedLeafProfileRecords } from './terminal-leaf-move'
import type { TerminalLeafMoveOriginLedger } from './terminal-leaf-move-origin-ledger'
import { planTerminalLeafMoveUndo } from './terminal-leaf-move-undo'
import type { TerminalSessionPartition } from './terminal-topology-membership'
import { withTopologyCommit } from './terminal-topology-write-guard'
import {
  startTerminalTopologyWriteSpan,
  type TerminalTopologyCommitKind
} from './terminal-topology-write-span'

/**
 * The commit boundary for class-(a) terminal topology (design §5.1). Each function wraps today's
 * writer unchanged; later stages route the remaining writers here. Binding joins in B1-4, when its
 * write first reaches a session sink.
 */

// Debt: the close transform still lives in runtime/; B1-8 moves it behind this module.
type CloseCommit<Target> = Omit<TerminalSurfaceCloseCommit, 'target'> & { target: Target }

/** closeLeaf for a pane target, closeTab for a tab target. */
export function closeLeafOrTab(
  commit: TerminalSurfaceCloseCommit
): () => DurableProfileStateMutation<Error | undefined> {
  const { target } = commit
  return target.kind === 'pane' ? closeLeaf({ ...commit, target }) : closeTab({ ...commit, target })
}

function closeLeaf(
  commit: CloseCommit<TerminalPaneCloseTarget>
): () => DurableProfileStateMutation<Error | undefined> {
  return topologyCommitMutation('close_leaf', terminalSurfaceCloseMutation(commit))
}

function closeTab(
  commit: CloseCommit<{ kind: 'tab'; tabId: string }>
): () => DurableProfileStateMutation<Error | undefined> {
  return topologyCommitMutation('close_tab', terminalSurfaceCloseMutation(commit))
}

function topologyCommitMutation(
  kind: TerminalTopologyCommitKind,
  mutate: () => DurableProfileStateMutation<Error | undefined>
): () => DurableProfileStateMutation<Error | undefined> {
  return () => {
    const span = startTerminalTopologyWriteSpan(kind)
    try {
      const result = withTopologyCommit(mutate)
      if (result.value instanceof Error) {
        // Close refusals are fixed reason codes, never ids.
        span.finish({ outcome: 'refused', refusal: result.value.message })
      } else {
        span.finish({ outcome: result.persist === false ? 'noop' : 'committed' })
      }
      return result
    } catch (error) {
      span.fail(error)
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
  return () => {
    const span = startTerminalTopologyWriteSpan(request.undo ? 'undo_move_leaf' : 'move_leaf')
    try {
      const mutation = withTopologyCommit(() => commitLeafMove(request, context))
      const result = mutation.value
      if (result.status === 'refused') {
        span.finish({ outcome: 'refused', refusal: result.reason })
      } else {
        span.finish({ outcome: mutation.persist === false ? 'noop' : 'committed' })
      }
      return mutation
    } catch (error) {
      span.fail(error)
      throw error
    }
  }
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
    commitWorkspaceSessionPartition(state, hostId, next)
    context.markDirty(
      hostId === LOCAL_EXECUTION_HOST_ID ? 'workspaceSession' : 'workspaceSessionsByHostId'
    )
    // A later write already replaced what this move wrote; never rewind it.
    return () => {
      if (context.getSession(hostId) === next) {
        commitWorkspaceSessionPartition(state, hostId, prior)
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
    rollback: () =>
      withTopologyCommit(() => {
        for (const restore of restores) {
          restore()
        }
        if (rekeyed.ui && state.ui === rekeyed.ui) {
          state.ui = priorUi
        }
        if (rekeyed.sshRemotePtyLeases && state.sshRemotePtyLeases === rekeyed.sshRemotePtyLeases) {
          state.sshRemotePtyLeases = priorLeases
        }
      })
  }
}
