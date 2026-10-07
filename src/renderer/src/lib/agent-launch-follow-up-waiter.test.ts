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
  const heldThreads: { keys: readonly unknown[]; settled: Promise<unknown> }[] = []
  return {
    capabilities,
    answers,
    calls,
    held,
    heldThreads,
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
vi.mock('@/components/right-sidebar/pr-comment-groups-in-flight', () => ({
  holdPRCommentGroupsForSend: (keys: readonly unknown[], settled: Promise<unknown>) =>
    state.heldThreads.push({ keys, settled })
}))

const { reviewCommentsResolutionFollowUp, reviewNotesDeliveredFollowUp } =
  await import('./agent-launch-follow-ups')
const { runRecordedLaunchFollowUps, waitForRecordedLaunchFollowUp } =
  await import('./agent-launch-follow-up-waiter')

const NOTE = { id: 'n1', body: 'fix this', filePath: 'a.ts', lineNumber: 3 }
const NOTES = reviewNotesDeliveredFollowUp('wt-1', [NOTE])
const COMMENT = {
  id: 7,
  author: 'reviewer',
  authorAvatarUrl: '',
  body: 'please rename this\n\nThe private details of why, which no reply quotes.',
  createdAt: '2026-01-01T00:00:00Z',
  url: 'https://example.test/c/7',
  threadId: 'thread-1',
  path: 'a.ts',
  line: 3
}
const RESOLUTION = reviewCommentsResolutionFollowUp({
  reviewContextKey: 'pr-1',
  provider: 'github',
  selectedGroups: [{ kind: 'thread', threadId: 'thread-1', root: COMMENT, replies: [COMMENT] }]
})

/** A clock the test turns by hand: timers fire on `advance`, the host's word on `settle`. */
function manualClock() {
  let now = 0
  const timers: { at: number; run: () => void }[] = []
  const listeners = new Set<(operationId: string) => void>()
  return {
    clock: {
      now: () => now,
      schedule: (ms: number, run: () => void) => {
        const timer = { at: now + ms, run }
        timers.push(timer)
        return () => timers.splice(timers.indexOf(timer), 1)
      },
      onSettled: (listener: (operationId: string) => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      }
    },
    advance(ms: number) {
      now += ms
      for (const timer of timers.filter((t) => t.at <= now)) {
        timers.splice(timers.indexOf(timer), 1)
        timer.run()
      }
    },
    settle: (operationId: string) => listeners.forEach((listener) => listener(operationId)),
    get listeners() {
      return listeners.size
    },
    get timers() {
      return timers.length
    }
  }
}

function taken(operationId: string, followUp: AgentLaunchFollowUp, promptHandedOver = true) {
  return { operationId, followUp, promptHandedOver, composerUnobserved: false }
}

beforeEach(() => {
  state.capabilities = [AGENT_LAUNCH_FOLLOW_UPS_RUNTIME_CAPABILITY]
  state.answers = []
  state.calls = []
  state.held = []
  state.heldThreads = []
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
    await runRecordedLaunchFollowUps(manualClock().clock)
    expect(state.clearDeliveredDiffComments).toHaveBeenCalledExactlyOnceWith('wt-1', [NOTE])
    expect(state.runResolution).toHaveBeenCalledOnce()
    expect(state.calls).toEqual([['agent.takeLaunchFollowUps', {}]])
  })

  it('runs nothing for a launch whose prompt never arrived', async () => {
    state.answers.push({ taken: [taken('op-1', NOTES, false)], pending: [] })
    await runRecordedLaunchFollowUps(manualClock().clock)
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
    await runRecordedLaunchFollowUps(manualClock().clock)
    expect(state.clearDeliveredDiffComments).not.toHaveBeenCalled()
  })

  it('holds what a launch still on its way acts on before running anything else', async () => {
    const order: string[] = []
    state.clearDeliveredDiffComments.mockImplementationOnce(async () => {
      order.push(`ran with ${state.held.length + state.heldThreads.length} held`)
      return true
    })
    state.answers.push({
      taken: [taken('op-1', NOTES)],
      pending: [
        { operationId: 'op-2', followUp: NOTES, deadline: 60_000 },
        { operationId: 'op-3', followUp: RESOLUTION, deadline: 60_000 }
      ]
    })
    const t = manualClock()
    void runRecordedLaunchFollowUps(t.clock)
    await vi.waitFor(() => expect(order).toEqual(['ran with 2 held']))
    expect(state.held[0]!.keys).toEqual(['n1'])
    expect(state.heldThreads[0]!.keys).toEqual(['thread:thread-1'])
  })

  it('runs a pending follow-up when the host says its prompt settled, and lets go', async () => {
    state.answers.push(
      { taken: [], pending: [{ operationId: 'op-1', followUp: NOTES, deadline: 60_000 }] },
      { taken: [taken('op-1', NOTES)], pending: [] }
    )
    const t = manualClock()
    const run = runRecordedLaunchFollowUps(t.clock)
    await vi.waitFor(() => expect(t.listeners).toBe(1))
    let released = false
    void state.held[0]!.settled.then(() => (released = true))
    t.settle('op-1')
    await run
    expect(released).toBe(true)
    expect(state.clearDeliveredDiffComments).toHaveBeenCalledOnce()
    // The take names the launch, so a click this window makes meanwhile stays its own.
    expect(state.calls.slice(1)).toEqual([['agent.takeLaunchFollowUps', { operationId: 'op-1' }]])
    expect(t.listeners).toBe(0)
    expect(t.timers).toBe(0)
  })

  it('keeps waiting when the word comes for a launch still owed', async () => {
    const stillPending = {
      taken: [],
      pending: [{ operationId: 'op-1', followUp: NOTES, deadline: 60_000 }]
    }
    state.answers.push(stillPending, stillPending)
    const t = manualClock()
    let finished = false
    void runRecordedLaunchFollowUps(t.clock).then(() => (finished = true))
    await vi.waitFor(() => expect(t.listeners).toBe(1))
    t.settle('op-1')
    await vi.waitFor(() => expect(state.calls).toHaveLength(2))
    expect(finished).toBe(false)
    expect(t.listeners).toBe(1)
  })

  it('takes once more just past the host’s deadline, then lets go of a launch still pending', async () => {
    const stillPending = {
      taken: [],
      pending: [{ operationId: 'op-1', followUp: NOTES, deadline: 60_000 }]
    }
    state.answers.push(stillPending, stillPending)
    const t = manualClock()
    const run = runRecordedLaunchFollowUps(t.clock)
    await vi.waitFor(() => expect(t.timers).toBe(1))
    t.advance(60_000 + 14_999)
    expect(state.calls).toHaveLength(1)
    t.advance(1)
    await run
    expect(state.calls).toHaveLength(2)
    expect(state.clearDeliveredDiffComments).not.toHaveBeenCalled()
    await expect(state.held[0]!.settled).resolves.toBeUndefined()
    expect(t.listeners).toBe(0)
  })

  it('runs a follow-up the last take finds settled', async () => {
    state.answers.push(
      { taken: [], pending: [{ operationId: 'op-1', followUp: NOTES, deadline: 60_000 }] },
      { taken: [taken('op-1', NOTES)], pending: [] }
    )
    const t = manualClock()
    const run = runRecordedLaunchFollowUps(t.clock)
    await vi.waitFor(() => expect(t.timers).toBe(1))
    t.advance(75_000)
    await run
    expect(state.clearDeliveredDiffComments).toHaveBeenCalledOnce()
  })

  it('asks nothing of a host that does not record follow-ups', async () => {
    state.capabilities = []
    await runRecordedLaunchFollowUps(manualClock().clock)
    expect(state.calls).toEqual([])
  })

  it('treats a host that cannot answer as nothing recorded', async () => {
    state.answers.push(new Error('method_not_found'))
    await expect(runRecordedLaunchFollowUps(manualClock().clock)).resolves.toBeUndefined()
    expect(state.clearDeliveredDiffComments).not.toHaveBeenCalled()
  })
})

describe('waiting on a launch’s follow-up, one take at a time', () => {
  it('keeps the host’s word that arrives while startup’s first take is still asking', async () => {
    let answerFirst: (take: AgentLaunchFollowUpTake) => void = () => {}
    state.answers.push(new Promise<AgentLaunchFollowUpTake>((resolve) => (answerFirst = resolve)), {
      taken: [taken('op-1', NOTES)],
      pending: []
    })
    const t = manualClock()
    const run = runRecordedLaunchFollowUps(t.clock)
    await vi.waitFor(() => expect(t.listeners).toBe(1))
    t.settle('op-1')
    answerFirst({
      taken: [],
      pending: [{ operationId: 'op-1', followUp: NOTES, deadline: 60_000 }]
    })
    await run
    expect(state.clearDeliveredDiffComments).toHaveBeenCalledOnce()
    expect(state.calls).toHaveLength(2)
  })

  it('never lets an empty answer release the hold while another take still runs it', async () => {
    let finishRun: () => void = () => {}
    state.clearDeliveredDiffComments.mockImplementationOnce(
      () => new Promise<boolean>((resolve) => (finishRun = () => resolve(true)))
    )
    state.answers.push(
      { taken: [], pending: [{ operationId: 'op-1', followUp: NOTES, deadline: 60_000 }] },
      { taken: [taken('op-1', NOTES)], pending: [] }
    )
    const t = manualClock()
    const run = runRecordedLaunchFollowUps(t.clock)
    await vi.waitFor(() => expect(t.listeners).toBe(1))
    let released = false
    void state.held[0]!.settled.then(() => (released = true))
    // Every sweep says so again: two words for one launch.
    t.settle('op-1')
    t.settle('op-1')
    await vi.waitFor(() => expect(state.clearDeliveredDiffComments).toHaveBeenCalledOnce())
    await Promise.resolve()
    expect(released).toBe(false)
    expect(state.calls).toHaveLength(2)
    finishRun()
    await run
    expect(released).toBe(true)
    // The second word found it already run, and asked nothing.
    expect(state.calls).toHaveLength(2)
  })

  it('holds a click’s follow-up its own take missed, and runs it when the host says so', async () => {
    state.answers.push({ taken: [taken('op-1', RESOLUTION)], pending: [] })
    const t = manualClock()
    const waited = waitForRecordedLaunchFollowUp('op-1', RESOLUTION, undefined, t.clock)
    expect(state.heldThreads[0]!.keys).toEqual(['thread:thread-1'])
    t.settle('op-1')
    await waited
    expect(state.runResolution).toHaveBeenCalledOnce()
    expect(t.listeners).toBe(0)
    expect(t.timers).toBe(0)
  })

  it('asks again a few seconds after a click’s take failed, not at the deadline', async () => {
    // The host's word came before the click's own take, so none will come again.
    state.answers.push({ taken: [taken('op-1', RESOLUTION)], pending: [] })
    const t = manualClock()
    const waited = waitForRecordedLaunchFollowUp('op-1', RESOLUTION, undefined, t.clock)
    t.advance(2_999)
    expect(state.calls).toEqual([])
    t.advance(1)
    await waited
    expect(state.calls).toEqual([['agent.takeLaunchFollowUps', { operationId: 'op-1' }]])
    expect(state.runResolution).toHaveBeenCalledOnce()
    expect(t.timers).toBe(0)
  })
})
