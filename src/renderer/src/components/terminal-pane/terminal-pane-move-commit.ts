import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type {
  TerminalLeafMoveRequest,
  TerminalLeafMoveResult
} from '../../../../shared/terminal-leaf-move'

export type CommitTerminalLeafMove = (
  request: TerminalLeafMoveRequest
) => Promise<TerminalLeafMoveResult>

// Why: main answers in milliseconds (B1-2 NOTES); a stalled answer must not wedge the pane's drag.
export const MOVE_COMMIT_TIMEOUT_MS = 10_000

export class MoveCommitTimeoutError extends Error {
  constructor() {
    super('terminal_pane_move_timed_out')
  }
}

/** Rejects with MoveCommitTimeoutError once the bound passes; main may still apply it later. */
export function commitMoveWithin(
  commitMove: CommitTerminalLeafMove,
  request: TerminalLeafMoveRequest,
  timeoutMs: number
): Promise<TerminalLeafMoveResult> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new MoveCommitTimeoutError()), timeoutMs)
  })
  return Promise.race([commitMove(request), timeout]).finally(() => clearTimeout(timer))
}

/** `undone`: main holds the leaf in its source (or never moved it); `retired`: the source closed. */
export type MoveUndoOutcome = 'undone' | 'retired' | 'failed'

export async function undoCommittedMove(
  commitMove: CommitTerminalLeafMove | undefined,
  request: TerminalLeafMoveRequest,
  timeoutMs: number
): Promise<MoveUndoOutcome> {
  if (!commitMove) {
    return 'undone'
  }
  try {
    // Undo is idempotent: main answers not_held when nothing moved.
    const undone = await commitMoveWithin(commitMove, { ...request, undo: true }, timeoutMs)
    if (undone.status === 'moved' || undone.status === 'not_held') {
      return 'undone'
    }
    if (undone.status === 'retired') {
      return 'retired'
    }
    console.warn('[terminal-pane-detach] main could not put the move back', undone)
  } catch (error) {
    console.warn('[terminal-pane-detach] main could not put the move back', error)
  }
  return 'failed'
}

/** `stayed`: main and this window both hold the pane in its source; `unknown`: main may not. */
export function reportMoveNotApplied(outcome: 'stayed' | 'unknown'): void {
  toast.error(
    outcome === 'stayed'
      ? translate(
          'terminal.paneMove.failed',
          "Couldn't move the pane to a new tab. It stays where it was."
        )
      : translate(
          'terminal.paneMove.unresolved',
          "Couldn't move the pane to a new tab. It may open in a new tab after Orca restarts."
        )
  )
}
