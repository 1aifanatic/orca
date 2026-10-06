import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AutomationRun } from '../../shared/automations-types'
import { RUN_TERMINAL_GRACE_MS } from './headless-run-terminal-retention'

vi.mock('./service', () => ({
  AutomationService: class {
    start = vi.fn()
    stop = vi.fn()
    markDispatchResult = vi.fn(async () => ({}))
  }
}))

import { createRuntimeAutomationService } from './runtime-automation-service'

function finishedRuns(count: number): AutomationRun[] {
  return Array.from(
    { length: count },
    (_, n) =>
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: retention reads only these run fields.
      ({
        id: `r${n}`,
        automationId: 'nightly',
        status: 'completed',
        error: null,
        terminalPaneKey: `tab-${n}:1`,
        dispatchedAt: n,
        startedAt: n,
        createdAt: n
      }) as AutomationRun
  )
}

function build(headless: boolean) {
  const runtime = {
    setAutomationService: vi.fn(),
    notifyAutomationsChanged: vi.fn(),
    getTerminalHandleForPaneKey: vi.fn((paneKey: string) => `handle:${paneKey}`),
    closeTerminalTab: vi.fn(async (_handle: string) => ({}))
  }
  const store = { listAutomationRuns: vi.fn(() => finishedRuns(5)), listAutomations: () => [] }
  const service = createRuntimeAutomationService({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mocked service and retention read only listAutomationRuns.
    store: store as never,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: retention reads only the members faked above.
    runtime: runtime as never,
    headless
  })
  return { runtime, service }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('headless automation service run terminal retention', () => {
  it('closes finished run terminals on orcad once the service runs, and stops with it', async () => {
    vi.useFakeTimers()
    const { runtime, service } = build(true)
    service.start()
    await vi.advanceTimersByTimeAsync(RUN_TERMINAL_GRACE_MS + 2 * 60_000)

    expect(runtime.closeTerminalTab.mock.calls.map(([handle]) => handle).toSorted()).toEqual([
      'handle:tab-0:1',
      'handle:tab-1:1'
    ])
    expect(service.markDispatchResult).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'r0', status: 'completed', terminalPaneKey: null })
    )

    service.stop()
    runtime.closeTerminalTab.mockClear()
    await vi.advanceTimersByTimeAsync(RUN_TERMINAL_GRACE_MS * 2)
    expect(runtime.closeTerminalTab).not.toHaveBeenCalled()
  })

  it('leaves run terminals to the renderer on the desktop', async () => {
    vi.useFakeTimers()
    const { runtime, service } = build(false)
    service.start()
    await vi.advanceTimersByTimeAsync(RUN_TERMINAL_GRACE_MS * 2)
    expect(runtime.closeTerminalTab).not.toHaveBeenCalled()
  })
})
