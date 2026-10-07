import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostAgentLaunchOutcome } from './agent-launch-through-host'
import type { AgentLaunchFollowUpTake } from '../../../shared/agent-launch-follow-up'

const host = vi.hoisted(() => ({
  launchAgentThroughHost: vi.fn(),
  windowMakesHostLaunchTab: vi.fn(() => true)
}))
vi.mock('@/lib/agent-launch-through-host', () => host)
const notice = vi.hoisted(() => ({ onTimeout: vi.fn(), wasNotified: vi.fn(() => true) }))
vi.mock('@/lib/launch-agent-paste-timeout-notice', () => ({
  createPasteReadinessTimeoutNotice: vi.fn(() => notice)
}))
const store = vi.hoisted(() => ({
  seedNativeChatLaunchPrompt: vi.fn(),
  markNativeChatLaunchPromptFailed: vi.fn()
}))
vi.mock('@/store', () => ({ useAppStore: { getState: () => store } }))
vi.mock('@/lib/command-code-prompt-status-seed', () => ({
  seedCommandCodeSubmittedPromptStatus: vi.fn()
}))
const toast = vi.hoisted(() => ({ error: vi.fn() }))
vi.mock('sonner', () => ({ toast }))
const followUps = vi.hoisted(() => {
  const order: string[] = []
  return {
    hostRecords: true,
    order,
    takeLaunchFollowUps: vi.fn(
      async (_operationId?: string): Promise<AgentLaunchFollowUpTake | null> => ({
        taken: [],
        pending: []
      })
    )
  }
})
vi.mock('@/lib/agent-launch-follow-ups', () => ({
  recordableLaunchFollowUp: (followUp: unknown) => (followUps.hostRecords ? followUp : undefined),
  takeLaunchFollowUps: async (operationId?: string) => {
    followUps.order.push('take')
    return followUps.takeLaunchFollowUps(operationId)
  }
}))

const { launchNewTabPromptThroughHost, newTabPromptLaunchesThroughHost } =
  await import('./launch-agent-new-tab-host-route')

const TAB = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d'

function deferredOutcome() {
  let resolve!: (outcome: HostAgentLaunchOutcome) => void
  const promise = new Promise<HostAgentLaunchOutcome>((done) => (resolve = done))
  host.launchAgentThroughHost.mockReturnValue({ tabId: TAB, operationId: 'op-1', outcome: promise })
  return resolve
}

function launch(
  callbacks: { onPromptDelivered?: () => void; onPromptDeliveryUnconfirmed?: () => void } = {}
) {
  return launchNewTabPromptThroughHost({
    agent: 'claude',
    worktreeId: 'wt-1',
    prompt: 'fix the failing checks',
    pasteContent: 'fix the failing checks\n\nlogs',
    ...callbacks
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  followUps.hostRecords = true
  followUps.order = []
  notice.wasNotified.mockReturnValue(true)
  host.windowMakesHostLaunchTab.mockReturnValue(true)
})

describe('an AI button launched through the host, which delivers its prompt', () => {
  it('sends the host what main pasted, and runs the follow-up once the host handed it over', async () => {
    const answer = deferredOutcome()
    const onPromptDelivered = vi.fn()
    const { tabId, promptDeliveryResult } = launch({ onPromptDelivered })
    expect(host.launchAgentThroughHost).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ hostPrompt: 'fix the failing checks\n\nlogs', worktreeId: 'wt-1' })
    )
    expect(onPromptDelivered).not.toHaveBeenCalled()
    // Seeded once the host started the agent, as main's paste seeded it.
    expect(store.seedNativeChatLaunchPrompt).not.toHaveBeenCalled()

    answer({ kind: 'started', prompt: { delivery: 'submit', outcome: 'handed-to-terminal' } })

    await expect(promptDeliveryResult).resolves.toEqual({ delivered: true, failureNotified: false })
    expect(store.seedNativeChatLaunchPrompt).toHaveBeenCalledOnce()
    expect(onPromptDelivered).toHaveBeenCalledOnce()
    expect(notice.onTimeout).not.toHaveBeenCalled()
    expect(tabId).toBe(TAB)
  })

  it('stamps the chat copy at the click, before the agent’s turn, though it is seeded on start', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    const answer = deferredOutcome()
    const { promptDeliveryResult } = launch()
    now.mockReturnValue(9_000)
    answer({ kind: 'started', prompt: { delivery: 'submit', outcome: 'handed-to-terminal' } })
    await promptDeliveryResult
    expect(store.seedNativeChatLaunchPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ createdAt: 1_000 })
    )
    now.mockRestore()
  })

  it('says the delivery was unconfirmed when the host wrote it without seeing the composer', async () => {
    const order: string[] = []
    deferredOutcome()({
      kind: 'started',
      prompt: { delivery: 'submit', outcome: 'handed-to-terminal', composerUnobserved: true }
    })
    await launch({
      onPromptDeliveryUnconfirmed: () => order.push('unconfirmed'),
      onPromptDelivered: () => order.push('delivered')
    }).promptDeliveryResult
    expect(order).toEqual(['unconfirmed', 'delivered'])
  })

  it('shows main’s "wasn’t sent" notice and runs no follow-up when the host could not deliver', async () => {
    const onPromptDelivered = vi.fn()
    deferredOutcome()({ kind: 'started', prompt: { delivery: 'submit', outcome: 'not-delivered' } })

    await expect(launch({ onPromptDelivered }).promptDeliveryResult).resolves.toEqual({
      delivered: false,
      failureNotified: true
    })
    expect(notice.onTimeout).toHaveBeenCalledOnce()
    expect(store.markNativeChatLaunchPromptFailed).toHaveBeenCalledWith(TAB)
    expect(onPromptDelivered).not.toHaveBeenCalled()
  })

  it('never runs a follow-up for a launch refused before the agent ran, and says so once', async () => {
    const onPromptDelivered = vi.fn()
    deferredOutcome()({ kind: 'not-started', unconfirmed: false, code: 'worktree_not_found' })

    await expect(launch({ onPromptDelivered }).promptDeliveryResult).resolves.toEqual({
      delivered: false,
      failureNotified: true
    })
    expect(onPromptDelivered).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalledOnce()
    expect(notice.onTimeout).not.toHaveBeenCalled()
    // Nothing started, so no chat copy is left behind.
    expect(store.seedNativeChatLaunchPrompt).not.toHaveBeenCalled()
  })

  it('offers nothing to send again for an answer that may have landed, and keeps its caller quiet', async () => {
    for (const prompt of [{ delivery: 'submit', outcome: 'unconfirmed' } as const, undefined]) {
      deferredOutcome()({ kind: 'started', ...(prompt ? { prompt } : {}) })
      // Reported as already said: the caller adds no "could not be sent" of its own.
      await expect(launch().promptDeliveryResult).resolves.toEqual({
        delivered: false,
        failureNotified: true
      })
    }
    expect(notice.onTimeout).not.toHaveBeenCalled()
  })

  it('says nothing when the user closed the tab, or its pane explains', async () => {
    for (const outcome of [{ kind: 'closed-by-user' }, { kind: 'pane-says' }] as const) {
      deferredOutcome()(outcome)
      await expect(launch().promptDeliveryResult).resolves.toEqual({
        delivered: false,
        failureNotified: true
      })
    }
    expect(toast.error).not.toHaveBeenCalled()
    expect(notice.onTimeout).not.toHaveBeenCalled()
  })
})

describe('a click whose follow-up is recorded on its launch', () => {
  const FOLLOW_UP = { kind: 'review-notes-delivered', version: 1, payload: {} }

  function launchWithFollowUp(onPromptDelivered: () => void) {
    return launchNewTabPromptThroughHost({
      agent: 'claude',
      worktreeId: 'wt-1',
      prompt: 'p',
      pasteContent: 'p',
      durableFollowUp: FOLLOW_UP,
      onPromptDelivered
    }).promptDeliveryResult
  }

  it('records it, then takes it off the record before it runs, so a reload never runs it again', async () => {
    followUps.takeLaunchFollowUps.mockResolvedValueOnce({
      taken: [
        {
          operationId: 'op-1',
          followUp: FOLLOW_UP,
          promptHandedOver: true,
          composerUnobserved: false
        }
      ],
      pending: []
    })
    deferredOutcome()({
      kind: 'started',
      prompt: { delivery: 'submit', outcome: 'handed-to-terminal' }
    })
    await launchNewTabPromptThroughHost({
      agent: 'claude',
      worktreeId: 'wt-1',
      prompt: 'p',
      pasteContent: 'p',
      durableFollowUp: FOLLOW_UP,
      onPromptDelivered: () => followUps.order.push('follow-up')
    }).promptDeliveryResult
    expect(host.launchAgentThroughHost).toHaveBeenCalledWith(
      expect.objectContaining({ followUp: FOLLOW_UP })
    )
    expect(followUps.takeLaunchFollowUps).toHaveBeenCalledWith('op-1')
    expect(followUps.order).toEqual(['take', 'follow-up'])
  })

  it('leaves it to the next start when this click could not take it, and says so', async () => {
    // Taken by a reloaded window already, or the host could not answer: it runs there, never here.
    for (const take of [{ taken: [], pending: [] }, null]) {
      followUps.takeLaunchFollowUps.mockResolvedValueOnce(take)
      deferredOutcome()({
        kind: 'started',
        prompt: { delivery: 'submit', outcome: 'handed-to-terminal' }
      })
      const onPromptDelivered = vi.fn()
      await expect(launchWithFollowUp(onPromptDelivered)).resolves.toEqual({
        delivered: true,
        failureNotified: false,
        followUpDeferred: true
      })
      expect(onPromptDelivered).not.toHaveBeenCalled()
    }
  })

  it('on a host that does not record follow-ups, runs it live and records nothing, as before', async () => {
    followUps.hostRecords = false
    deferredOutcome()({
      kind: 'started',
      prompt: { delivery: 'submit', outcome: 'handed-to-terminal' }
    })
    const onPromptDelivered = vi.fn()
    await launchNewTabPromptThroughHost({
      agent: 'claude',
      worktreeId: 'wt-1',
      prompt: 'p',
      pasteContent: 'p',
      durableFollowUp: FOLLOW_UP,
      onPromptDelivered
    }).promptDeliveryResult
    expect(host.launchAgentThroughHost).toHaveBeenCalledWith(
      expect.not.objectContaining({ followUp: expect.anything() })
    )
    expect(followUps.takeLaunchFollowUps).not.toHaveBeenCalled()
    expect(onPromptDelivered).toHaveBeenCalledOnce()
  })
})

describe('which new agent tabs start through the host', () => {
  it('an AI button whose prompt is pasted once ready, in a terminal this window makes', () => {
    expect(
      newTabPromptLaunchesThroughHost({ promptDelivery: 'submit-after-ready', pastesPrompt: true })
    ).toBe(true)
  })

  it('never a typed prompt, nor a launch the host could turn into a chat', () => {
    expect(
      newTabPromptLaunchesThroughHost({ promptDelivery: 'auto-submit', pastesPrompt: true })
    ).toBe(false)
    expect(newTabPromptLaunchesThroughHost({ promptDelivery: 'draft', pastesPrompt: true })).toBe(
      false
    )
    host.windowMakesHostLaunchTab.mockReturnValue(false)
    expect(
      newTabPromptLaunchesThroughHost({ promptDelivery: 'submit-after-ready', pastesPrompt: true })
    ).toBe(false)
  })
})
