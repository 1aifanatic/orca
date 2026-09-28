import { afterEach, describe, expect, it, vi } from 'vitest'
import { createOrchestrationWorkerReleaseHarness } from './worker-release.test-support'

describe('composer-marker first dispatch readiness', () => {
  const h = createOrchestrationWorkerReleaseHarness()
  afterEach(() => h.cleanup())

  // DSH's idle hook fires only after a turn, so like ZCode its captured composer is its readiness.
  it.each(['zcode', 'dsh'] as const)(
    'waits for %s’s new composer before delivering exactly one dispatch',
    async (agent) => {
      h.setup()
      const gate = h.deferred<void>()
      vi.spyOn(h.runtime, 'waitForFreshWorkerComposer').mockReturnValue(gate.promise)
      const pending = h.startWorker({ agent })
      await vi.waitFor(() =>
        expect(h.runtime.waitForFreshWorkerComposer).toHaveBeenCalledWith(
          'term_worker',
          agent,
          60_000
        )
      )
      expect(h.runtime.waitForTerminal).not.toHaveBeenCalled()
      expect(h.runtime.sendTerminalAgentPrompt).not.toHaveBeenCalled()
      gate.resolve()
      await pending
      expect(h.runtime.sendTerminalAgentPrompt).toHaveBeenCalledOnce()
    }
  )

  it('keeps reused terminals on the normal idle wait', async () => {
    h.setup()
    vi.spyOn(h.runtime, 'waitForFreshWorkerComposer')
    await h.startWorker({ terminal: 'term_worker' })
    expect(h.runtime.waitForFreshWorkerComposer).not.toHaveBeenCalled()
    expect(h.runtime.waitForTerminal).toHaveBeenCalledWith(
      'term_worker',
      expect.objectContaining({ condition: 'tui-idle' })
    )
  })

  it('never delivers a task after a startup timeout', async () => {
    h.setup()
    vi.spyOn(h.runtime, 'waitForFreshWorkerComposer').mockRejectedValue(new Error('timeout'))
    await expect(h.startWorker({ agent: 'zcode' })).rejects.toThrow('Expected worker-start')
    expect(h.runtime.sendTerminalAgentPrompt).not.toHaveBeenCalled()
  })
})
