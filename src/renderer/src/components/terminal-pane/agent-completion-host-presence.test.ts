import { describe, expect, it, vi } from 'vitest'
import type {
  AgentProcessPresence,
  AgentProcessVerdict
} from '../../../../shared/agent-process-presence'
import { createAgentCompletionCoordinator } from './agent-completion-coordinator'
import {
  createDeferred,
  processResult,
  useAgentCompletionCoordinatorLifecycle
} from './agent-completion-coordinator-test-harness'

const owner = {
  agent: 'claude',
  process: { pid: 4001, platform: 'linux', startTime: 'birth' }
} as const

describe('completion from the recorded process owner', () => {
  useAgentCompletionCoordinatorLifecycle()

  it('ignores foreground absence until the execution host reports exit', async () => {
    let verdict: AgentProcessVerdict = 'live'
    const inspectProcess = vi.fn(async () => processResult(null, false))
    const dispatchCompletion = vi.fn()
    const checkAgentPresence = vi.fn(async () => verdict)
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab:leaf',
      getPtyId: () => 'pty',
      getSettings: () => null,
      isLive: () => true,
      getAgentPresence: () => owner,
      checkAgentPresence,
      inspectProcess,
      dispatchCompletion
    })
    coordinator.startProcessTracking()
    coordinator.observeTitle('Claude working')
    await vi.advanceTimersByTimeAsync(8_000)
    verdict = 'unverifiable'
    await vi.advanceTimersByTimeAsync(8_000)
    expect(inspectProcess).not.toHaveBeenCalled()
    expect(dispatchCompletion).not.toHaveBeenCalled()
    verdict = 'exited'
    await vi.advanceTimersByTimeAsync(8_000)
    expect(dispatchCompletion).toHaveBeenCalledTimes(1)
    expect(dispatchCompletion).toHaveBeenCalledWith(
      'claude',
      expect.objectContaining({ source: 'process-exit' })
    )
    coordinator.dispose()
  })

  it('does not retire a replacement owner from a delayed verdict', async () => {
    let presence: AgentProcessPresence = owner
    const deferred = createDeferred<AgentProcessVerdict>()
    const inspectProcess = vi.fn(async () => processResult(null, false))
    const dispatchCompletion = vi.fn()
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab:leaf',
      getPtyId: () => 'pty',
      getSettings: () => null,
      isLive: () => true,
      getAgentPresence: () => presence,
      checkAgentPresence: () => deferred.promise,
      inspectProcess,
      dispatchCompletion
    })
    coordinator.startProcessTracking()
    coordinator.observeTitle('Claude working')
    await vi.advanceTimersByTimeAsync(1_000)
    presence = { ...owner, process: { ...owner.process, startTime: 'replacement' } }
    deferred.resolve('exited')
    await vi.advanceTimersByTimeAsync(1)
    expect(dispatchCompletion).not.toHaveBeenCalled()
    expect(inspectProcess).not.toHaveBeenCalled()
    coordinator.dispose()
  })
})
