import { afterEach, expect, it, vi } from 'vitest'
import { AgentPresenceCommandObserver } from '../../../../shared/agent-presence-command-observer'
import { createAgentCompletionPollScheduler } from './agent-completion-poll-scheduler'
import type { ProcessMonitorState } from './agent-completion-process-types'

afterEach(() => vi.useRealTimers())

it('uses fewer resolver calls than the legacy scheduler for the same command sequence', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
  const commandResolver = vi.fn(async () => {})
  const legacyResolver = vi.fn()
  const observer = new AgentPresenceCommandObserver(commandResolver)
  const state: ProcessMonitorState = {
    disposed: false,
    inspectionInFlight: false,
    inspectionGeneration: 0,
    consecutiveInspectionErrors: 0,
    pollTrackingStarted: true,
    pollTimer: null,
    pollTimerTier: null,
    lastPaneActivityAt: null,
    hasAgentRunEvidence: false,
    pendingProcessExit: null,
    lastForegroundAgent: null,
    processSession: 0
  }
  const scheduler = createAgentCompletionPollScheduler({
    state,
    options: {
      paneKey: 'pane',
      getPtyId: () => 'pty',
      getSettings: () => null,
      inspectProcess: vi.fn(),
      dispatchCompletion: vi.fn(),
      isLive: () => true,
      isProcessInspectionCostly: () => true
    },
    pendingTitle: {
      get: () => null,
      hold: vi.fn(),
      drop: vi.fn(),
      finishInspection: vi.fn(),
      clearTimer: vi.fn()
    },
    requestInspection: () => {
      legacyResolver()
      scheduler.scheduleNextPoll()
    }
  })
  scheduler.scheduleNextPoll()
  for (const duration of [30_000, 200, 30_000]) {
    state.lastPaneActivityAt = Date.now()
    scheduler.scheduleNextPoll()
    observer.start('pty')
    observer.start('pty')
    await vi.advanceTimersByTimeAsync(duration)
    observer.end('pty')
  }
  const beforeIdle = legacyResolver.mock.calls.length
  await vi.advanceTimersByTimeAsync(60_000)
  expect(commandResolver).toHaveBeenCalledTimes(2)
  expect(legacyResolver.mock.calls.length).toBeGreaterThan(commandResolver.mock.calls.length)
  expect(legacyResolver.mock.calls.length).toBeGreaterThan(beforeIdle)
  observer.stop()
  scheduler.clearPollTimer()
})
