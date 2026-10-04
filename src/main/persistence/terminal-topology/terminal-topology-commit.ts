import type { TerminalPaneCloseTarget } from '../../../shared/terminal-surface-close-target'
import {
  terminalSurfaceCloseMutation,
  type TerminalSurfaceCloseCommit
} from '../../runtime/terminal-surface-close'
import type { DurableProfileStateMutation } from '../loading-store/store-runtime-state'
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
