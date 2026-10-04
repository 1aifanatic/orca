import type { TerminalPaneCloseTarget } from '../../../shared/terminal-surface-close-target'
import {
  terminalSurfaceCloseMutation,
  type TerminalSurfaceCloseCommit
} from '../../runtime/terminal-surface-close'
import type { DurableProfileStateMutation } from '../loading-store/store-runtime-state'
import type { Store } from '../loading-store/store'
import { withTopologyCommit } from './terminal-topology-write-guard'
import {
  startTerminalTopologyWriteSpan,
  type TerminalTopologyCommitKind
} from './terminal-topology-write-span'

/**
 * The commit boundary for class-(a) terminal topology (design §5.1). Each function wraps today's
 * writer unchanged; later stages route the remaining writers here.
 */

/** `persistPtyBinding` is the binding commit; it marks its own write as inside the boundary. */
export function bindLeaf(
  store: Pick<Store, 'persistPtyBinding'>,
  ...args: Parameters<Store['persistPtyBinding']>
): ReturnType<Store['persistPtyBinding']> {
  return store.persistPtyBinding(...args)
}

type CloseCommit<Target> = Omit<TerminalSurfaceCloseCommit, 'target'> & { target: Target }

export function closeLeaf(
  commit: CloseCommit<TerminalPaneCloseTarget>
): () => DurableProfileStateMutation<Error | undefined> {
  return topologyCommitMutation('close_leaf', terminalSurfaceCloseMutation(commit))
}

export function closeTab(
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
