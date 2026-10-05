import { startSpan } from '../../observability/tracer'

/** Bindings are not listed: `persistPtyBinding` already records `persistence.pty-binding`. */
export type TerminalTopologyCommitKind = 'close_leaf' | 'close_tab' | 'move_leaf' | 'undo_move_leaf'

type TerminalTopologyCommitOutcome = 'committed' | 'noop' | 'refused' | 'threw'

type TerminalTopologyWriteSpan = {
  /** `detail` is the refusal reason code for `refused` and the error for `threw`. */
  finish(outcome: TerminalTopologyCommitOutcome, detail?: unknown): void
}

/**
 * One `persistence.terminal-topology` span per topology commit, from admission to the in-memory
 * write. Attributes stay low-cardinality: no pane key, PTY id or path.
 */
export function startTerminalTopologyWriteSpan(
  kind: TerminalTopologyCommitKind
): TerminalTopologyWriteSpan {
  const span = startSpan('persistence.terminal-topology', {
    attributes: { kind: 'persistence', 'topology.kind': kind }
  })
  return {
    finish(outcome, detail) {
      span.setAttribute('topology.outcome', outcome)
      if (outcome === 'threw') {
        span.fail(detail instanceof Error ? detail : String(detail))
        return
      }
      if (outcome === 'refused') {
        span.setAttribute('topology.refusal', String(detail))
      }
      span.end()
    }
  }
}
