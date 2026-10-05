import {
  terminalSurfaceCloseMutation,
  type TerminalSurfaceCloseCommit
} from '../../runtime/terminal-surface-close'
import type { DurableProfileStateMutation } from '../loading-store/store-runtime-state'
import { startTerminalTopologyWriteSpan } from './terminal-topology-write-span'

/**
 * The commit boundary for class-(a) terminal topology (design §5.1). Today it wraps the explicit
 * close; later stages route the remaining writers here, binding in B1-4. Debt: the close transform
 * still lives in runtime/ until B1-8 moves it behind this module.
 */

/** Closes one pane (close_leaf) or a whole tab (close_tab), unchanged, inside the topology span. */
export function closeLeafOrTab(
  commit: TerminalSurfaceCloseCommit
): () => DurableProfileStateMutation<Error | undefined> {
  const mutate = terminalSurfaceCloseMutation(commit)
  const kind = commit.target.kind === 'pane' ? 'close_leaf' : 'close_tab'
  return () => {
    const span = startTerminalTopologyWriteSpan(kind)
    try {
      const result = mutate()
      if (result.value instanceof Error) {
        // Close refusals are fixed reason codes, never ids.
        span.finish('refused', result.value.message)
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
