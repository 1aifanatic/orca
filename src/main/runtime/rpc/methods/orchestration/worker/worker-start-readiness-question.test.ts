import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createOrchestrationWorkerReleaseHarness } from './worker-release.test-support'

// A worker the start just launched is ready once its composer mounts; a reused terminal's agent was
// already running and may be mid-turn, so for it the question stays "is it idle".
describe('worker-start readiness question', () => {
  const harness = createOrchestrationWorkerReleaseHarness()
  beforeEach(() => harness.setup())
  afterEach(() => harness.cleanup())

  function readinessWait() {
    return vi.mocked(harness.runtime.waitForTerminal).mock.calls[0]?.[1]
  }

  it('accepts composer evidence for a terminal it launched', async () => {
    await harness.startWorker()
    expect(readinessWait()).toMatchObject({ condition: 'tui-idle', acceptComposerReady: true })
  })

  it('does not accept composer evidence for a reused terminal', async () => {
    await harness.startWorker({ terminal: 'term_worker' })
    expect(readinessWait()).toMatchObject({ condition: 'tui-idle', acceptComposerReady: false })
  })
})
