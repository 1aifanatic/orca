import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostAgentLaunchOutcome } from './agent-launch-through-host'

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

const { launchNewTabPromptThroughHost, newTabPromptLaunchesThroughHost } =
  await import('./launch-agent-new-tab-host-route')

const TAB = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d'

function deferredOutcome() {
  let resolve!: (outcome: HostAgentLaunchOutcome) => void
  const promise = new Promise<HostAgentLaunchOutcome>((done) => (resolve = done))
  host.launchAgentThroughHost.mockReturnValue({ tabId: TAB, outcome: promise })
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

  it('never says "paste it" for an answer that may have landed', async () => {
    for (const prompt of [{ delivery: 'submit', outcome: 'unconfirmed' } as const, undefined]) {
      deferredOutcome()({ kind: 'started', ...(prompt ? { prompt } : {}) })
      await expect(launch().promptDeliveryResult).resolves.toEqual({
        delivered: false,
        failureNotified: false
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
