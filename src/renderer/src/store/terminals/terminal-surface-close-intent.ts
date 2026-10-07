import type { TerminalSurfaceCloseTarget } from '../../../../shared/terminal-surface-close-target'
import type { TerminalSlice } from './terminal-state'

/** Commits a terminal tab or split-pane close in main, which owns membership. The surface stays
 *  hidden here until main's topology drops it, so an older push cannot bring it back. */
export function commitTerminalSurfaceClose(
  store: Pick<TerminalSlice, 'markPendingTerminalPane' | 'settlePendingTerminalPaneRemoval'>,
  worktreeId: string,
  target: TerminalSurfaceCloseTarget,
  reason?: 'user' | 'cleanup'
): void {
  const pane = {
    worktreeId,
    tabId: target.tabId,
    ...(target.kind === 'pane' ? { leafId: target.leafId } : {})
  }
  store.markPendingTerminalPane({ ...pane, change: 'remove' })
  // Why optional: an older preload can linger through an in-place renderer reload.
  void Promise.resolve(
    globalThis.window?.api?.session?.closeTerminalSurface?.({
      worktreeId,
      target,
      ...(reason ? { reason } : {})
    })
  ).then(
    (reply) => store.settlePendingTerminalPaneRemoval(pane, reply?.publishSeq),
    (error: unknown) => {
      console.warn('[terminal-close] main did not commit the close', error)
      store.settlePendingTerminalPaneRemoval(pane)
    }
  )
}
