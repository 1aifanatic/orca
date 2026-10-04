import type { RuntimeWorktreePsSummary } from '../shared/runtime-types'
import type { PtyLivenessVerdict } from '../shared/pty-liveness-verdict'

type TerminalCounts = Pick<
  RuntimeWorktreePsSummary,
  'liveTerminalCount' | 'hasAttachedPty' | 'unverifiableTerminalCount'
>

type TerminalVerdict = PtyLivenessVerdict['status']

function terminalVerdict(row: TerminalCounts): TerminalVerdict {
  if (row.liveTerminalCount > 0) {
    return 'live'
  }
  return (row.unverifiableTerminalCount ?? 0) > 0 ? 'unverifiable' : 'exited'
}

/** `live:` and `pty:` words for one row; lost contact never reads as zero or no. */
export function formatWorktreePsTerminalFields(row: TerminalCounts): string {
  const unverifiable = row.unverifiableTerminalCount ?? 0
  if (unverifiable === 0) {
    return `live:${row.liveTerminalCount}  pty:${row.hasAttachedPty ? 'yes' : 'no'}`
  }
  if (row.liveTerminalCount === 0) {
    return 'live:unverifiable  pty:unverifiable'
  }
  return `live:${row.liveTerminalCount}+${unverifiable} unverifiable  pty:${row.hasAttachedPty ? 'yes' : 'unverifiable'}`
}

/**
 * JSON counterpart. The count fields keep their number/boolean types for existing scripts, so
 * `terminalVerdict` is what says a 0/false came from a host that could not be asked.
 */
export function projectWorktreePsTerminalVerdict<TRow extends TerminalCounts>(
  row: TRow
): TRow & { terminalVerdict: TerminalVerdict } {
  return { ...row, terminalVerdict: terminalVerdict(row) }
}
