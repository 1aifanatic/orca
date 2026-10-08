import * as runner from './structured-agent-session-restart-resume-runner'
import { afterEach, expect, it, vi } from 'vitest'
import type { AgentSessionStatusSummary } from '../../../shared/agent-session-wire'
import { AgentSessionRecoveryCapsule } from '../../runtime/agent-session-recovery-capsule'
import {
  interruptedRestart,
  startAgent,
  throwAfterContinuationAccepted
} from './structured-agent-session-restart-interruption-test-harness'
import { HOST_TEST_SESSION as SESSION } from './structured-agent-session-host-test-data'

afterEach(() => vi.restoreAllMocks())

it('publishes skipped when an offer disappears during reservation without starting its agent', async () => {
  const { host, acquire, dispatch } = await interruptedRestart()
  expect(await host.restartResume.list()).toHaveLength(1)
  vi.spyOn(AgentSessionRecoveryCapsule.prototype, 'beginResume').mockResolvedValueOnce([])
  const phases: (string | undefined)[] = []
  const release = host.subscribeStatus({
    id: 'reservation-skipped',
    emit: (event) => {
      if (event.type === 'status') {
        phases.push(event.session.restartResume?.phase)
      }
    }
  })
  try {
    const result = await host.restartResume.continueAfterRestart([SESSION], 'modal')
    expect(result).toMatchObject({ skipped: [SESSION], resumed: [], continued: [] })
    expect(phases).toEqual(['skipped', undefined])
    expect(acquire).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
  } finally {
    release()
  }
})

it('publishes skipped for an offer started elsewhere and sends no continuation', async () => {
  const state = await interruptedRestart()
  expect(await state.host.restartResume.list()).toHaveLength(1)
  await startAgent(state)
  state.acquire.mockClear()
  const summaries: AgentSessionStatusSummary[] = []
  const release = state.host.subscribeStatus({
    id: 'skipped',
    emit: (event) => {
      if (event.type === 'status') {
        summaries.push(event.session)
      }
    }
  })
  try {
    const result = await state.host.restartResume.continueAfterRestart([SESSION], 'modal')
    expect(result).toMatchObject({ skipped: [SESSION], resumed: [], continued: [] })
    expect(state.acquire).not.toHaveBeenCalled()
    expect(state.dispatch).not.toHaveBeenCalled()
    expect(summaries.map((summary) => summary.restartResume?.phase)).toContain('skipped')
    expect(summaries.at(-1)).not.toHaveProperty('restartResume')
  } finally {
    release()
  }
})

it.each(['continued', 'refused', 'unconfirmed'] as const)(
  'publishes %s before bookkeeping finishes, then clears progress on return',
  async (phase) => {
    const { host, acquire } = await interruptedRestart()
    await host.restartResume.list()
    const summaries: AgentSessionStatusSummary[] = []
    const release = host.subscribeStatus({
      id: 'progress',
      emit: (event) => {
        if (event.type === 'status') {
          summaries.push(event.session)
        }
      }
    })
    if (phase === 'refused') {
      acquire.mockRejectedValueOnce(new Error('start refused'))
    }
    if (phase === 'unconfirmed') {
      throwAfterContinuationAccepted()
    }
    const bookkeeping = Promise.withResolvers<void>()
    const complete = AgentSessionRecoveryCapsule.prototype.completeResume
    vi.spyOn(AgentSessionRecoveryCapsule.prototype, 'completeResume').mockImplementation(
      async function (this: AgentSessionRecoveryCapsule, ...args) {
        await bookkeeping.promise
        return complete.apply(this, args)
      }
    )
    let finished = false
    const action = host.restartResume.continueAfterRestart([SESSION], 'modal').then((result) => {
      finished = true
      return result
    })
    try {
      await vi.waitFor(() => expect(summaries.at(-1)?.restartResume?.phase).toBe(phase))
      expect(finished).toBe(false)
      expect(summaries.map((summary) => summary.restartResume?.phase)).toContain('queued')
      expect(summaries.map((summary) => summary.restartResume?.phase)).toContain('starting')
      // Reopening takes a snapshot of the same live action, without needing its earlier frames.
      const snapshots: AgentSessionStatusSummary[] = []
      const closeSnapshot = host.subscribeStatus({
        id: 'reopen',
        emit: (event) => {
          if (event.type === 'snapshot') {
            snapshots.push(...event.sessions)
          }
        }
      })
      expect(snapshots.find((summary) => summary.sessionId === SESSION)?.restartResume?.phase).toBe(
        phase
      )
      closeSnapshot()
    } finally {
      bookkeeping.resolve()
      await action
      release()
    }
    expect(summaries.at(-1)).not.toHaveProperty('restartResume')
  }
)

it('clears progress when the resume action throws', async () => {
  const { host } = await interruptedRestart()
  await host.restartResume.list()
  const summaries: AgentSessionStatusSummary[] = []
  const release = host.subscribeStatus({
    id: 'progress',
    emit: (event) => {
      if (event.type === 'status') {
        summaries.push(event.session)
      }
    }
  })
  const resume = runner.resumeStructuredAgentSessionsFromRestart
  vi.spyOn(runner, 'resumeStructuredAgentSessionsFromRestart').mockImplementation(
    async (...args) => {
      await resume(...args)
      throw new Error('resume action failed')
    }
  )
  await expect(host.restartResume.continueAfterRestart([SESSION], 'modal')).rejects.toThrow(
    'resume action failed'
  )
  expect(summaries.some((summary) => summary.restartResume?.phase === 'starting')).toBe(true)
  expect(summaries.at(-1)).not.toHaveProperty('restartResume')
  release()
})
