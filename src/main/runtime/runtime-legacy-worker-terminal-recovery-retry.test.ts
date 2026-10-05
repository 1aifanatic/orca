import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  RuntimeLegacyWorkerTerminalRecoveryController,
  __cancelLegacyWorkerTerminalRecoveryRetriesForTests
} from './runtime-legacy-worker-terminal-recovery-controller'
import type {
  LegacyWorkerRecoveryPorts,
  LegacyWorkerTerminalRecoveryResult
} from './runtime-legacy-worker-terminal-recovery-types'
import type { LegacyWorkerTerminalRecoveryPlan } from './orchestration/orchestration-legacy-worker-terminal-recovery'
import {
  missingWorkspaceRecoveryFixture,
  missingWorkspaceWorker
} from './runtime-legacy-worker-recovery-test-fixture'
import { toAppSshPtyId } from '../../shared/ssh-pty-id'

const DEFERRED_DISPATCH_ID = 'dispatch-1'

const DEFERRED_PLAN: LegacyWorkerTerminalRecoveryPlan = {
  ambiguousDispatchIds: [],
  candidates: [
    {
      dispatchId: DEFERRED_DISPATCH_ID,
      dispatchStatus: 'dispatched',
      contractVersion: 1,
      taskId: 'task-1',
      worktreeId: 'repo-1::/tmp/worktree-a',
      terminalHandle: 'handle-1',
      paneKey: 'tab-1:pane-1',
      tabId: 'tab-1',
      leafId: 'pane-1',
      processIncarnation: 'pty-1:inc-1',
      ptyId: 'pty-1',
      incarnationId: 'inc-1'
    }
  ]
}

const EMPTY_RESULT: LegacyWorkerTerminalRecoveryResult = {
  adoptedDispatchIds: [],
  exitedDispatchIds: [],
  deferredDispatchIds: [DEFERRED_DISPATCH_ID]
}

function armedController(): {
  controller: RuntimeLegacyWorkerTerminalRecoveryController
  reconcile: ReturnType<typeof vi.fn>
} {
  const reconcile = vi.fn(async () => EMPTY_RESULT)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the retry timer only ever reaches `ports.reconcile`; the rest of the port surface is unreachable from `updateRetry`.
  const ports = { reconcile } as unknown as LegacyWorkerRecoveryPorts
  const controller = new RuntimeLegacyWorkerTerminalRecoveryController(ports)
  controller.updateRetry(DEFERRED_PLAN, new Set([DEFERRED_DISPATCH_ID]), {})
  return { controller, reconcile }
}

describe('RuntimeLegacyWorkerTerminalRecoveryController retry loop', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    __cancelLegacyWorkerTerminalRecoveryRetriesForTests()
    vi.useRealTimers()
  })

  it('keeps retrying recovery while a worker stays deferred', async () => {
    const { reconcile } = armedController()

    await vi.advanceTimersByTimeAsync(1_000)

    expect(reconcile).toHaveBeenCalledTimes(1)
  })

  it('stops a controller retry loop once its scopes are cancelled', async () => {
    const { controller, reconcile } = armedController()

    controller.cancelAllRetries()
    await vi.advanceTimersByTimeAsync(60_000)

    expect(reconcile).not.toHaveBeenCalled()
  })

  it('reaches every armed controller from the test cancel hook', async () => {
    // Why the hook exists: the retry re-arms itself for as long as a worker stays deferred, so a
    // suite that never resolves one keeps a recovery loop — and the worktree scans it issues —
    // running inside whichever later test happens to be executing when the timer fires.
    const first = armedController()
    const second = armedController()

    __cancelLegacyWorkerTerminalRecoveryRetriesForTests()
    await vi.advanceTimersByTimeAsync(60_000)

    expect(first.reconcile).not.toHaveBeenCalled()
    expect(second.reconcile).not.toHaveBeenCalled()
  })

  it('exhausts automatic retries without settling an unverifiable worker, then permits explicit recovery', async () => {
    const fixture = missingWorkspaceRecoveryFixture()
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      await fixture.controller.reconcile()
      await vi.advanceTimersByTimeAsync(600_000)

      expect(fixture.reconcile).toHaveBeenCalledTimes(6)
      expect(fixture.reconcileMissing).not.toHaveBeenCalled()
      expect(fixture.persist.mock.calls.every(([resolutions]) => resolutions.length === 0)).toBe(
        true
      )
      expect(vi.getTimerCount()).toBe(0)
      expect(warning).toHaveBeenCalledTimes(1)

      await fixture.controller.reconcile({ materializeRenderer: true })
      await vi.advanceTimersByTimeAsync(1_000)
      expect(fixture.reconcile).toHaveBeenCalledTimes(7)
      expect(fixture.reconcile).toHaveBeenLastCalledWith({ retry: true, materializeRenderer: true })
    } finally {
      warning.mockRestore()
    }
  })

  it('keeps other host timers cancellable after the local retry budget is exhausted', async () => {
    const local = missingWorkspaceWorker()
    const remote = missingWorkspaceWorker({
      dispatchId: 'dispatch-remote',
      ptyId: toAppSshPtyId('server-1', 'pty-remote')
    })
    const fixture = missingWorkspaceRecoveryFixture([local, remote])
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      await fixture.controller.reconcile()
      await vi.advanceTimersByTimeAsync(31_000)
      await fixture.controller.reconcile({ connectionId: 'server-1' })
      await vi.advanceTimersByTimeAsync(30_000)
      const callsBeforeCancellation = fixture.reconcile.mock.calls.length
      expect(vi.getTimerCount()).toBe(1)

      __cancelLegacyWorkerTerminalRecoveryRetriesForTests()
      await vi.advanceTimersByTimeAsync(60_000)
      expect(fixture.reconcile).toHaveBeenCalledTimes(callsBeforeCancellation)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      warning.mockRestore()
    }
  })

  it('bounds retries when the provider throws rather than returning a recovery result', async () => {
    const { controller, reconcile } = armedController()
    reconcile.mockRejectedValue(new Error('provider unavailable'))
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      await vi.advanceTimersByTimeAsync(600_000)
      expect(reconcile).toHaveBeenCalledTimes(6)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      controller.cancelAllRetries()
      warning.mockRestore()
    }
  })
})
