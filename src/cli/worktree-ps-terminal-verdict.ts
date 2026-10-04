import type { RuntimeWorktreePsSummary } from '../shared/runtime-types'

type TerminalCounts = Pick<
  RuntimeWorktreePsSummary,
  'liveTerminalCount' | 'hasAttachedPty' | 'unverifiableTerminalCount'
>

/** `live:` and `pty:` words for one row; lost contact never reads as zero or no. */
export function formatWorktreePsTerminalFields(row: TerminalCounts): string {
  const unverifiable = row.unverifiableTerminalCount ?? 0
  if (unverifiable === 0) {
    return `live:${row.liveTerminalCount}  pty:${row.hasAttachedPty ? 'yes' : 'no'}`
  }
  if (row.liveTerminalCount === 0) {
    return 'live:unverifiable  pty:unverifiable'
  }
  return `live:${row.liveTerminalCount}+${unverifiable} unverifiable  pty:yes`
}

/** JSON counterpart: a row with only unverifiable terminals carries that word instead of 0/false. */
export function projectWorktreePsTerminalVerdict<TRow extends TerminalCounts>(
  row: TRow
):
  | TRow
  | (Omit<TRow, 'liveTerminalCount' | 'hasAttachedPty'> & {
      liveTerminalCount: 'unverifiable'
      hasAttachedPty: 'unverifiable'
    }) {
  if ((row.unverifiableTerminalCount ?? 0) === 0 || row.liveTerminalCount > 0) {
    return row
  }
  return { ...row, liveTerminalCount: 'unverifiable', hasAttachedPty: 'unverifiable' }
}
