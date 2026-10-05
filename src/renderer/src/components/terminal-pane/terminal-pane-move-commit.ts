import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type {
  TerminalLeafMoveRequest,
  TerminalLeafMoveResult
} from '../../../../shared/terminal-leaf-move'

export type CommitTerminalLeafMove = (
  request: TerminalLeafMoveRequest
) => Promise<TerminalLeafMoveResult>

const MOVE_COMMIT_ATTEMPTS = 3

/**
 * Asks main to move the pane, retrying a throw: the write may have landed, and a repeat of a
 * committed move answers `moved` without writing again. Null when every attempt threw.
 */
export async function commitMoveWithRetry(
  commitMove: CommitTerminalLeafMove,
  request: TerminalLeafMoveRequest
): Promise<TerminalLeafMoveResult | null> {
  for (let attempt = 1; attempt <= MOVE_COMMIT_ATTEMPTS; attempt += 1) {
    try {
      return await commitMove(request)
    } catch (error) {
      console.warn('[terminal-pane-detach] main did not answer the move', { attempt, error })
    }
  }
  return null
}

export function reportMoveFailed(): void {
  toast.error(translate('terminal.paneMove.failed', "Couldn't move the pane to a new tab."))
}
