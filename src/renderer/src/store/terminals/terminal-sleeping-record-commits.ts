import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session-resume'
import type { TerminalSleepingRecordChanges } from '../../../../shared/terminal-topology-slice'

type SleepingRecords = Record<string, SleepingAgentSessionRecord>

/**
 * Runs `write`, then sends main the window's own change to its sleeping-agent records. Sent at
 * once: a window's IPC reaches main in order, so the quit capture lands before the quit stage.
 * Not for a mirror apply, a tab close or a pane move: main already holds those.
 */
export function commitSleepingRecordWrite(
  get: () => { sleepingAgentSessionsByPaneKey: SleepingRecords },
  write: () => void
): void {
  const before = get().sleepingAgentSessionsByPaneKey
  write()
  const after = get().sleepingAgentSessionsByPaneKey
  if (before === after) {
    return
  }
  const changes: TerminalSleepingRecordChanges = {
    sleep: Object.fromEntries(
      Object.entries(after).filter(([paneKey, record]) => before[paneKey] !== record)
    ),
    wake: Object.keys(before).filter((paneKey) => !Object.hasOwn(after, paneKey))
  }
  if (Object.keys(changes.sleep).length === 0 && changes.wake.length === 0) {
    return
  }
  // Why optional: an older preload can linger through an in-place renderer reload.
  void Promise.resolve(
    globalThis.window?.api?.session?.commitTerminalSleepingRecords?.(changes)
  ).catch((error: unknown) =>
    console.warn('[terminal-sleep] main did not commit sleeping records', error)
  )
}
