/**
 * Closing finished run terminals on a headless host. The desktop closes a run's terminal when the
 * run completes; on orcad nobody does, so hourly schedules leave a shell and a PTY per run until
 * the host runs out. A completed run's terminal stays open for a grace period and the newest few
 * per automation stay viewable; older ones are closed. A run that has not finished is never
 * touched, since its agent may still be working, and neither is a terminal a client typed into or
 * is viewing, or one whose use this host cannot tell: as on the desktop, that terminal is the user's.
 */
import type { AutomationRun } from '../../shared/automations-types'

export const RUN_TERMINAL_GRACE_MS = 10 * 60_000
export const RUN_TERMINALS_KEPT_PER_AUTOMATION = 3
const SWEEP_INTERVAL_MS = 60_000

export type HeadlessRunTerminalRetentionDeps = {
  listRuns: () => readonly AutomationRun[]
  /**
   * Whether any client drove or is viewing the run's terminal. Like the desktop's take-over rule,
   * a used terminal is the user's now; `unknown` keeps it too.
   */
  terminalClientUse: (run: AutomationRun) => 'used' | 'unused' | 'unknown'
  /**
   * Closes the run's own pane, leaving any pane a user split into that tab. False, closing
   * nothing, when the pane is gone or now holds another PTY (a restart put a new one there).
   */
  closeRunTerminal: (run: AutomationRun) => Promise<boolean>
  /** Drops the closed terminal from the run, keeping its status, error and output. */
  forgetRunTerminal: (run: AutomationRun) => Promise<void>
  now?: () => number
}

export function createHeadlessRunTerminalRetention(deps: HeadlessRunTerminalRetentionDeps): {
  sweep: () => Promise<void>
  /** Before an update restarts the server: no grace, no newest-N, every other rule still holds. */
  drain: () => Promise<number>
  start: () => void
  stop: () => void
} {
  const now = deps.now ?? Date.now
  // When each finished run was first seen finished; the grace runs from there.
  const finishedSeenAt = new Map<string, number>()
  let timer: ReturnType<typeof setInterval> | null = null
  let sweeping: Promise<void> | null = null

  const sweepOnce = async (policy: { keep: number; graceMs: number }): Promise<number> => {
    let closedCount = 0
    const finishedByAutomation = new Map<string, AutomationRun[]>()
    for (const run of deps.listRuns()) {
      // Only completed: a failed run can still hold a live agent (blocked on a prompt, past the
      // watch window, or after an observer error), as the desktop never closes those either.
      if (!run.terminalPaneKey || run.status !== 'completed') {
        continue
      }
      if (!finishedSeenAt.has(run.id)) {
        finishedSeenAt.set(run.id, now())
      }
      finishedByAutomation.set(run.automationId, [
        ...(finishedByAutomation.get(run.automationId) ?? []),
        run
      ])
    }
    for (const runs of finishedByAutomation.values()) {
      const newestFirst = runs.toSorted((a, b) => runRecency(b) - runRecency(a))
      for (const run of newestFirst.slice(policy.keep)) {
        if (
          now() - (finishedSeenAt.get(run.id) ?? now()) < policy.graceMs ||
          deps.terminalClientUse(run) !== 'unused'
        ) {
          continue
        }
        try {
          if (await deps.closeRunTerminal(run)) {
            closedCount += 1
          }
          await deps.forgetRunTerminal(run)
          finishedSeenAt.delete(run.id)
        } catch (error) {
          console.error('[automations] could not close a finished run terminal:', error)
        }
      }
    }
    return closedCount
  }

  const sweep = (): Promise<void> => {
    sweeping ??= sweepOnce({
      keep: RUN_TERMINALS_KEPT_PER_AUTOMATION,
      graceMs: RUN_TERMINAL_GRACE_MS
    })
      .then(() => {})
      .finally(() => {
        sweeping = null
      })
    return sweeping
  }

  const drain = async (): Promise<number> => {
    // Waits out a periodic sweep so the two never close the same terminal twice.
    await sweeping?.catch(() => {})
    return sweepOnce({ keep: 0, graceMs: 0 })
  }

  return {
    sweep,
    drain,
    start: () => {
      timer ??= setInterval(() => void sweep(), SWEEP_INTERVAL_MS)
      timer.unref?.()
    },
    stop: () => {
      if (timer) {
        clearInterval(timer)
        timer = null
      }
    }
  }
}

function runRecency(run: AutomationRun): number {
  return run.dispatchedAt ?? run.startedAt ?? run.createdAt
}
