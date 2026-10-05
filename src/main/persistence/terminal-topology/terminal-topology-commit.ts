import { startSpan } from '../../observability/tracer'
import {
  terminalSurfaceCloseMutation,
  type TerminalSurfaceCloseCommit
} from '../../runtime/terminal-surface-close'
import type { DurableProfileStateMutation } from '../loading-store/store-runtime-state'

/**
 * The commit boundary for class-(a) terminal topology (design §5.1). Today it wraps the explicit
 * close; later stages route the remaining writers here, binding in B1-4. Debt: the close transform
 * still lives in runtime/ until B1-8 moves it behind this module.
 */

/** Bindings are not listed: `persistPtyBinding` already records `persistence.pty-binding`. */
type TerminalTopologyCommitKind = 'close_leaf' | 'close_tab'

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
      if (result.value instanceof Error) {
        span.setAttribute('topology.outcome', 'refused')
        // Refusals are fixed reason codes, never ids.
        span.setAttribute('topology.refusal', result.value.message)
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
