import { startSpan } from '../../observability/tracer'

/** Bindings are not listed: `persistPtyBinding` already records `persistence.pty-binding`. */
export type TerminalTopologyCommitKind = 'close_leaf' | 'close_tab' | 'move_leaf' | 'undo_move_leaf'

export type TerminalTopologyCommitOutcome = 'committed' | 'noop' | 'refused' | 'threw'

export type TerminalTopologyWriteSpan = {
  finish(entry: {
    outcome: Exclude<TerminalTopologyCommitOutcome, 'threw'>
    refusal?: string
  }): void
  fail(error: unknown): void
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
    finish({ outcome, refusal }) {
      span.setAttribute('topology.outcome', outcome)
      if (refusal) {
        span.setAttribute('topology.refusal', refusal)
      }
      span.end()
    },
    fail(error) {
      span.setAttribute('topology.outcome', 'threw')
      span.fail(error instanceof Error ? error : String(error))
    }
  }
}
