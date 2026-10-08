import type { TerminalSurfaceCloseTarget } from '../../../../shared/terminal-surface-close-target'
import {
  commitPendingTerminalChange,
  type PendingTerminalChangeStore
} from './terminal-pending-panes'
import type { TerminalSlice } from './terminal-state'

/** Commits a terminal tab or split-pane close in main, which owns membership. The surface stays
 *  hidden here until main's topology drops it, so an older push cannot bring it back. */
export function commitTerminalSurfaceClose(
  store: PendingTerminalChangeStore & Pick<TerminalSlice, 'markPendingTerminalPane'>,
  worktreeId: string,
  target: TerminalSurfaceCloseTarget,
  reason?: 'user' | 'cleanup'
): void {
  commitPendingTerminalChange(
    store,
    {
      worktreeId,
      tabId: target.tabId,
      ...(target.kind === 'pane' ? { leafId: target.leafId } : {}),
      change: 'remove'
    },
    // Why optional: an older preload can linger through an in-place renderer reload.
    () =>
      globalThis.window?.api?.session?.closeTerminalSurface?.({
        worktreeId,
        target,
        ...(reason ? { reason } : {})
      })
  )
}
