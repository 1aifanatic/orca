import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AutomationRun, AutomationRunStatus } from '../../shared/automations-types'
import {
  createHeadlessRunTerminalRetention,
  RUN_TERMINAL_GRACE_MS,
  RUN_TERMINALS_KEPT_PER_AUTOMATION
} from './headless-run-terminal-retention'

function makeRun(
  id: string,
  dispatchedAt: number,
  status: AutomationRunStatus = 'completed',
  automationId = 'nightly'
): AutomationRun {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: retention reads only these run fields.
  return {
    id,
    automationId,
    status,
    error: status === 'dispatch_failed' ? 'agent missing' : null,
    terminalPaneKey: `tab-${id}:1`,
    dispatchedAt,
    startedAt: dispatchedAt,
    createdAt: dispatchedAt
  } as AutomationRun
}

function harness(runs: AutomationRun[]) {
  const closed: string[] = []
  const forgotten: AutomationRun[] = []
  const retention = createHeadlessRunTerminalRetention({
    listRuns: () => runs.filter((run) => !forgotten.some((gone) => gone.id === run.id)),
    closeRunTerminal: async (paneKey) => {
      closed.push(paneKey)
      return true
    },
    forgetRunTerminal: async (run) => {
      forgotten.push(run)
    }
  })
  return { retention, closed, forgotten }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('headless run terminal retention', () => {
  it('closes finished run terminals past the grace period, keeping the newest few viewable', async () => {
    // Six hourly runs of one automation, all finished.
    const runs = [0, 1, 2, 3, 4, 5].map((hour) => makeRun(`r${hour}`, hour * 3_600_000))
    const h = harness(runs)

    await h.retention.sweep()
    expect(h.closed).toEqual([])

    vi.advanceTimersByTime(RUN_TERMINAL_GRACE_MS)
    await h.retention.sweep()
    expect(h.closed.toSorted()).toEqual(['tab-r0:1', 'tab-r1:1', 'tab-r2:1'])
    expect(6 - h.closed.length).toBe(RUN_TERMINALS_KEPT_PER_AUTOMATION)
  })

  it('never closes a run that has not finished, however old', async () => {
    const runs = [
      makeRun('working', 0, 'dispatched'),
      makeRun('starting', 1, 'dispatching'),
      ...[2, 3, 4, 5].map((n) => makeRun(`done${n}`, n))
    ]
    const h = harness(runs)
    await h.retention.sweep()
    vi.advanceTimersByTime(RUN_TERMINAL_GRACE_MS * 10)
    await h.retention.sweep()
    expect(h.closed).toEqual(['tab-done2:1'])
  })

  it('treats failed runs alike and keeps their status and error when forgetting the terminal', async () => {
    const runs = [0, 1, 2, 3].map((n) => makeRun(`f${n}`, n, 'dispatch_failed'))
    const h = harness(runs)
    await h.retention.sweep()
    vi.advanceTimersByTime(RUN_TERMINAL_GRACE_MS)
    await h.retention.sweep()
    expect(h.closed).toEqual(['tab-f0:1'])
    expect(h.forgotten[0]).toMatchObject({ status: 'dispatch_failed', error: 'agent missing' })
  })

  it('keeps the newest few per automation, not across all of them', async () => {
    const runs = [
      ...[0, 1, 2].map((n) => makeRun(`a${n}`, n, 'completed', 'a')),
      ...[0, 1, 2].map((n) => makeRun(`b${n}`, n, 'completed', 'b'))
    ]
    const h = harness(runs)
    await h.retention.sweep()
    vi.advanceTimersByTime(RUN_TERMINAL_GRACE_MS)
    await h.retention.sweep()
    expect(h.closed).toEqual([])
  })

  it('sweeps on its own once started, and stops with the service', async () => {
    const runs = [0, 1, 2, 3].map((n) => makeRun(`r${n}`, n))
    const h = harness(runs)
    h.retention.start()
    await vi.advanceTimersByTimeAsync(RUN_TERMINAL_GRACE_MS + 2 * 60_000)
    expect(h.closed).toEqual(['tab-r0:1'])

    h.retention.stop()
    runs.push(makeRun('r4', 4), makeRun('r5', 5))
    await vi.advanceTimersByTimeAsync(RUN_TERMINAL_GRACE_MS * 2)
    expect(h.closed).toEqual(['tab-r0:1'])
  })
})
