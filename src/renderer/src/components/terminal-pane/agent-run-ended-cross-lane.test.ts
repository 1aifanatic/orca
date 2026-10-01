import { describe, expect, it, vi } from 'vitest'
import { createAgentCompletionCoordinator } from './agent-completion-coordinator'
import {
  processResult,
  useAgentCompletionCoordinatorLifecycle
} from './agent-completion-coordinator-test-harness'

const PANE_KEY = 'tab-1:11111111-1111-4111-8111-111111111111'

// A visible pane polling its foreground, beside the hook lane that announces the run's end.
function createLanes() {
  let foreground: string | null = 'opencode'
  const paneDispatch = vi.fn()
  const hookDispatch = vi.fn()
  const paneLane = createAgentCompletionCoordinator({
    paneKey: PANE_KEY,
    statusLane: 'pty',
    getPtyId: () => 'pty-1',
    getSettings: () => null,
    inspectProcess: vi.fn(async () => processResult(foreground)),
    dispatchCompletion: paneDispatch,
    isLive: () => true,
    shouldPollProcessCadence: () => true
  })
  paneLane.startProcessTracking()
  const hookLane = createAgentCompletionCoordinator({
    paneKey: PANE_KEY,
    statusLane: 'hook',
    getPtyId: () => 'pty-1',
    getSettings: () => null,
    inspectProcess: vi.fn(async () => processResult(null)),
    dispatchCompletion: hookDispatch,
    isLive: () => true
  })
  hookLane.observeHookStatus({
    state: 'working',
    prompt: '',
    agentType: 'opencode',
    stateStartedAt: Date.now()
  })
  return {
    paneDispatch,
    hookDispatch,
    exitProcess: () => {
      foreground = null
    },
    announceEnd: () =>
      hookLane.observeAgentRunEnded({
        state: 'done',
        prompt: '',
        agentType: 'opencode',
        stateStartedAt: Date.now()
      })
  }
}

// Why: the pane's own process-exit completion shares the per-pane identity with the hook lane,
// so whichever lane announces the run first, the other adds nothing.
describe('ended-run announcement beside the pane process monitor', () => {
  useAgentCompletionCoordinatorLifecycle()

  it('keeps the process-exit completion silent after the run’s end was announced', async () => {
    const lanes = createLanes()
    await vi.advanceTimersByTimeAsync(10_000)

    lanes.exitProcess()
    lanes.announceEnd()
    await vi.advanceTimersByTimeAsync(10_000)

    expect(lanes.hookDispatch).toHaveBeenCalledTimes(1)
    expect(lanes.paneDispatch).not.toHaveBeenCalled()
  })

  it('announces nothing more when the process-exit completion came first', async () => {
    const lanes = createLanes()
    await vi.advanceTimersByTimeAsync(10_000)

    lanes.exitProcess()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(lanes.paneDispatch).toHaveBeenCalledTimes(1)
    lanes.announceEnd()
    await vi.advanceTimersByTimeAsync(10_000)

    expect(lanes.hookDispatch).not.toHaveBeenCalled()
  })
})
