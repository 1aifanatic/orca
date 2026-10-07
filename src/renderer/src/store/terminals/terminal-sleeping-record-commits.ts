import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session-resume'
import type { TerminalSleepingRecordChanges } from '../../../../shared/terminal-topology-slice'

type SleepingRecords = Record<string, SleepingAgentSessionRecord>

/** Each pane's latest unsent value; null drops its record. */
const unsent = new Map<string, SleepingAgentSessionRecord | null>()

/**
 * Runs `write`, then sends main the window's own change to its sleeping-agent records, batched per
 * microtask. The store keeps the new value meanwhile; main's next topology push brings back the
 * committed one. Not for a mirror apply, a tab close or a pane move: main already holds those.
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
  const wasEmpty = unsent.size === 0
  for (const [paneKey, record] of Object.entries(after)) {
    if (before[paneKey] !== record) {
      unsent.set(paneKey, record)
    }
  }
  for (const paneKey of Object.keys(before)) {
    if (!Object.hasOwn(after, paneKey)) {
      unsent.set(paneKey, null)
    }
  }
  if (wasEmpty && unsent.size > 0) {
    queueMicrotask(sendSleepingRecordChanges)
  }
}

/** Empties the batch; the quit stage carries it synchronously instead. */
export function takeSleepingRecordChanges(): TerminalSleepingRecordChanges {
  const changes: TerminalSleepingRecordChanges = { sleep: {}, wake: [] }
  for (const [paneKey, record] of unsent) {
    if (record) {
      changes.sleep[paneKey] = record
    } else {
      changes.wake.push(paneKey)
    }
  }
  unsent.clear()
  return changes
}

function sendSleepingRecordChanges(): void {
  const { sleep, wake } = takeSleepingRecordChanges()
  // Why optional: an older preload can linger through an in-place renderer reload.
  const session = globalThis.window?.api?.session
  const warn = (error: unknown): void =>
    console.warn('[terminal-sleep] main did not commit sleeping records', error)
  if (wake.length > 0) {
    void Promise.resolve(session?.wakeTerminalLeaves?.(wake)).catch(warn)
  }
  if (Object.keys(sleep).length > 0) {
    void Promise.resolve(session?.sleepTerminalLeaves?.(sleep)).catch(warn)
  }
}
