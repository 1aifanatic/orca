import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentLaunchFollowUp,
  AgentLaunchFollowUpTake
} from '../../../shared/agent-launch-follow-up'
import { AGENT_LAUNCH_FOLLOW_UPS_RUNTIME_CAPABILITY } from '../../../shared/agent-launch-runtime-capability'

const state = vi.hoisted(() => {
  const capabilities: string[] = []
  const answers: unknown[] = []
  const calls: unknown[] = []
  const held: { keys: readonly unknown[]; settled: Promise<unknown> }[] = []
  return {
    capabilities,
    answers,
    calls,
    held,
    clearDeliveredDiffComments: vi.fn(async () => true),
    runResolution: vi.fn(async () => {})
  }
})

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({ clearDeliveredDiffComments: state.clearDeliveredDiffComments })
  }
}))
vi.mock('@/runtime/local-runtime-capabilities', () => ({
  ensureLocalRuntimeCapabilities: async () => state.capabilities,
  readLocalRuntimeCapabilitiesOrUnknown: () => state.capabilities
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: vi.fn(async (_target: unknown, method: string, params: unknown) => {
    state.calls.push([method, params])
    const answer = state.answers.shift()
    if (answer instanceof Error) {
      throw answer
    }
    return answer ?? { taken: [], pending: [] }
  })
}))
vi.mock('@/lib/notes-send-in-flight', () => ({
  diffCommentSendKey: (note: { id: string }) => note.id,
  holdNotesForSend: (keys: readonly unknown[], settled: Promise<unknown>) =>
    state.held.push({ keys, settled })
}))
vi.mock('@/components/right-sidebar/review-comments-resolution-follow-up', () => ({
  runReviewCommentsResolutionFollowUp: state.runResolution
}))

const {
  recordableLaunchFollowUp,
  reviewCommentsResolutionFollowUp,
  reviewNotesDeliveredFollowUp,
  runRecordedLaunchFollowUps
} = await import('./agent-launch-follow-ups')

const NOTE = { id: 'n1', body: 'fix this', filePath: 'a.ts', lineNumber: 3 }
const NOTES = reviewNotesDeliveredFollowUp('wt-1', [NOTE])
const RESOLUTION = reviewCommentsResolutionFollowUp({
  reviewContextKey: 'pr-1',
  provider: 'github',
  selectedGroups: []
})

function taken(operationId: string, followUp: AgentLaunchFollowUp, promptHandedOver = true) {
  return { operationId, followUp, promptHandedOver, composerUnobserved: false }
}

beforeEach(() => {
  state.capabilities = [AGENT_LAUNCH_FOLLOW_UPS_RUNTIME_CAPABILITY]
  state.answers = []
  state.calls = []
  state.held = []
  state.clearDeliveredDiffComments.mockClear()
  state.runResolution.mockClear()
})
afterEach(() => vi.restoreAllMocks())

describe('a window that reloaded mid-launch runs what its launches recorded', () => {
  it('runs each follow-up whose prompt was handed over, once', async () => {
    const take: AgentLaunchFollowUpTake = {
      taken: [taken('op-1', NOTES), taken('op-2', RESOLUTION)],
      pending: []
    }
    state.answers.push(take)
    await runRecordedLaunchFollowUps()
    expect(state.clearDeliveredDiffComments).toHaveBeenCalledExactlyOnceWith('wt-1', [NOTE])
    expect(state.runResolution).toHaveBeenCalledOnce()
    expect(state.calls).toEqual([['agent.takeLaunchFollowUps', {}]])
  })

  it('runs nothing for a launch whose prompt never arrived', async () => {
    state.answers.push({ taken: [taken('op-1', NOTES, false)], pending: [] })
    await runRecordedLaunchFollowUps()
    expect(state.clearDeliveredDiffComments).not.toHaveBeenCalled()
  })

  it('discards a kind or version this build does not know, and a payload it cannot read', async () => {
    state.answers.push({
      taken: [
        taken('op-1', { ...NOTES, version: 2 }),
        taken('op-2', { kind: 'unknown-kind', version: 1, payload: {} }),
        taken('op-3', { ...NOTES, payload: { worktreeId: 'wt-1' } })
      ],
      pending: []
    })
    await runRecordedLaunchFollowUps()
    expect(state.clearDeliveredDiffComments).not.toHaveBeenCalled()
  })

  it('keeps notes still waiting on their prompt unsendable, then runs them once taken', async () => {
    state.answers.push(
      { taken: [], pending: [{ operationId: 'op-1', followUp: NOTES }] },
      { taken: [], pending: [{ operationId: 'op-1', followUp: NOTES }] },
      { taken: [taken('op-1', NOTES)], pending: [] }
    )
    let released = false
    const run = runRecordedLaunchFollowUps({ wait: async () => {}, pollMs: 1 })
    await vi.waitFor(() => expect(state.held).toHaveLength(1))
    void state.held[0]!.settled.then(() => (released = true))
    await run
    expect(state.held[0]!.keys).toEqual(['n1'])
    expect(released).toBe(true)
    expect(state.clearDeliveredDiffComments).toHaveBeenCalledOnce()
    // The re-ask names the launch, so a click this window makes meanwhile stays its own.
    expect(state.calls.slice(1)).toEqual([
      ['agent.takeLaunchFollowUps', { operationId: 'op-1' }],
      ['agent.takeLaunchFollowUps', { operationId: 'op-1' }]
    ])
  })

  it('stops asking at its bound and leaves the follow-up on the record', async () => {
    const pending = { taken: [], pending: [{ operationId: 'op-1', followUp: NOTES }] }
    state.answers.push(pending, pending, pending, pending)
    let now = 0
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    await runRecordedLaunchFollowUps({
      maxWaitMs: 3,
      pollMs: 1,
      wait: async (ms) => {
        now += ms
      }
    })
    expect(state.clearDeliveredDiffComments).not.toHaveBeenCalled()
    expect(state.calls).toHaveLength(4)
    await expect(state.held[0]!.settled).resolves.toBeUndefined()
  })

  it('asks nothing of a host that does not record follow-ups', async () => {
    state.capabilities = []
    await runRecordedLaunchFollowUps()
    expect(state.calls).toEqual([])
  })

  it('treats a host that cannot answer as nothing recorded', async () => {
    state.answers.push(new Error('method_not_found'))
    await expect(runRecordedLaunchFollowUps()).resolves.toBeUndefined()
    expect(state.clearDeliveredDiffComments).not.toHaveBeenCalled()
  })
})

describe('which follow-ups a launch records', () => {
  it('only on a host that keeps them, and only under the size cap', () => {
    expect(recordableLaunchFollowUp(NOTES)).toBe(NOTES)
    expect(recordableLaunchFollowUp(undefined)).toBeUndefined()
    const huge = reviewNotesDeliveredFollowUp('wt-1', [{ ...NOTE, body: 'x'.repeat(300 * 1024) }])
    expect(recordableLaunchFollowUp(huge)).toBeUndefined()
    state.capabilities = []
    expect(recordableLaunchFollowUp(NOTES)).toBeUndefined()
  })
})
