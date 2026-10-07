/**
 * Marks a window close that a user Quit asked for on a host that stays running (`orca serve`).
 * Why separate from isQuitting: the process is not quitting, but the close still needs the quit
 * close semantics — the frozen-renderer ack deadline and no minimize-to-tray.
 */
const pendingUserQuitCloses = new WeakSet<object>()

export function markUserQuitWindowClose(window: object): void {
  pendingUserQuitCloses.add(window)
}

/** One close attempt consumes the mark, so a later plain close keeps its own semantics. */
export function consumeUserQuitWindowClose(window: object): boolean {
  return pendingUserQuitCloses.delete(window)
}
