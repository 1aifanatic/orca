// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ call: vi.fn() }))

vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: mocks.call,
  ensureRuntimeEnvironmentCompatible: vi.fn(async () => undefined)
}))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  // Sends reach the runtime RPC through this wrapper, as in the app.
  callStructuredAgentSession: (target: unknown, method: string, params?: unknown) =>
    mocks.call(target, method, params)
}))

import {
  resetStructuredAgentSessionSendsForTests,
  sendStructuredAgentSessionMessage
} from '@/components/native-chat/structured-agent-session-message-sender'
import {
  clearNativeChatDraftCacheForTests,
  readNativeChatDraftCache
} from '@/components/native-chat/native-chat-draft-cache'
import { structuredAgentSessionDraftScopeKey } from '@/components/native-chat/native-chat-composer-draft-store'
import { getStructuredAgentSessionPendingSends } from '@/components/native-chat/structured-agent-session-pending-sends'
import {
  discardStructuredLaunchPrompts,
  hasStagedStructuredLaunchPrompt,
  settleStructuredAgentLaunchPrompt,
  stageStructuredLaunchPrompt
} from './structured-agent-session-launch-prompt'

const SESSION = 'session-1'
const target = { kind: 'local' } as const

function accepted(clientMessageId: string) {
  return {
    ok: true,
    replayed: false,
    fence: 1,
    cursor: { epoch: 'epoch-1', sequence: 1 },
    value: {
      clientMessageId,
      submission: {
        clientMessageId,
        fence: 1,
        payloadFingerprint: 'fingerprint',
        dispatchState: 'accepted',
        providerItemId: null,
        reason: null,
        submittedAt: 1,
        resolvedAt: null
      }
    }
  }
}

function sends(): unknown[][] {
  return mocks.call.mock.calls.filter(([, method]) => method === 'agentSession.send')
}

function pendingTexts(): string[] {
  return getStructuredAgentSessionPendingSends(SESSION).map(
    (entry) =>
      `${entry.body.blocks.map((block) => (block.type === 'text' ? block.text : '')).join('')}:${entry.phase}`
  )
}

function draft(): string {
  return readNativeChatDraftCache(structuredAgentSessionDraftScopeKey(SESSION))
}

describe('settleStructuredAgentLaunchPrompt', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    resetStructuredAgentSessionSendsForTests()
    clearNativeChatDraftCacheForTests()
    discardStructuredLaunchPrompts(SESSION)
    mocks.call.mockImplementation(async (_target, _method, params) =>
      accepted(params.envelope.clientOperationId)
    )
  })

  it('sends the prompt once after the launch publishes, under its receipt fence', async () => {
    const stagedPrompt = stageStructuredLaunchPrompt(SESSION, 'review this')
    const onPromptDelivered = vi.fn()

    await expect(
      settleStructuredAgentLaunchPrompt({
        launchResult: Promise.resolve({ sessionId: SESSION, fence: 7 }),
        target,
        options: { prompt: 'review this', onPromptDelivered },
        stagedPrompt
      })
    ).resolves.toEqual({ delivered: true, failureNotified: false })

    expect(onPromptDelivered).toHaveBeenCalledOnce()
    // The receipt's fence is known, so no history read precedes the send.
    expect(mocks.call.mock.calls.map(([, method]) => method)).toEqual(['agentSession.send'])
    expect(sends()[0]?.[2]).toMatchObject({
      envelope: { sessionId: SESSION, expectedRuntimeFence: 7 },
      body: { blocks: [{ type: 'text', text: 'review this' }] }
    })
    expect(hasStagedStructuredLaunchPrompt(SESSION)).toBe(false)
  })

  it('shares one send between every caller waiting on the same staged prompt', async () => {
    const stagedPrompt = stageStructuredLaunchPrompt(SESSION, 'review this')
    const launchResult = Promise.resolve({ sessionId: SESSION, fence: 1 })
    const settle = () =>
      settleStructuredAgentLaunchPrompt({
        launchResult,
        target,
        options: { prompt: 'review this' },
        stagedPrompt
      })

    const results = await Promise.all([settle(), settle()])

    expect(results).toEqual([
      { delivered: true, failureNotified: false },
      { delivered: true, failureNotified: false }
    ])
    expect(sends()).toHaveLength(1)
  })

  it("puts the prompt in the chat's composer when the launch fails, and rethrows", async () => {
    const stagedPrompt = stageStructuredLaunchPrompt(SESSION, 'review this')
    const failure = new Error('create refused')

    await expect(
      settleStructuredAgentLaunchPrompt({
        launchResult: Promise.reject(failure),
        target,
        options: { prompt: 'review this' },
        stagedPrompt
      })
    ).rejects.toBe(failure)

    expect(draft()).toBe('review this')
    expect(sends()).toHaveLength(0)
    expect(hasStagedStructuredLaunchPrompt(SESSION)).toBe(false)
  })

  it('neither sends nor gives back a prompt whose launch was cancelled', async () => {
    const stagedPrompt = stageStructuredLaunchPrompt(SESSION, 'review this')
    discardStructuredLaunchPrompts(SESSION)

    await expect(
      settleStructuredAgentLaunchPrompt({
        launchResult: Promise.resolve({ sessionId: SESSION, fence: 1 }),
        target,
        options: { prompt: 'review this' },
        stagedPrompt
      })
    ).resolves.toEqual({ delivered: false, failureNotified: true })
    await expect(
      settleStructuredAgentLaunchPrompt({
        launchResult: Promise.reject(new Error('cancelled')),
        target,
        options: { prompt: 'review this' },
        stagedPrompt
      })
    ).rejects.toThrow('cancelled')

    expect(sends()).toHaveLength(0)
    expect(draft()).toBe('')
  })

  it('reports a prompt the host refused as not delivered, with its text back in the composer', async () => {
    const stagedPrompt = stageStructuredLaunchPrompt(SESSION, 'review this')
    const onPromptDelivered = vi.fn()
    mocks.call.mockResolvedValue({
      ok: false,
      refusal: { code: 'agent_session_checkpoint_stale', message: 'stale' }
    })

    await expect(
      settleStructuredAgentLaunchPrompt({
        launchResult: Promise.resolve({ sessionId: SESSION, fence: 1 }),
        target,
        options: { prompt: 'review this', onPromptDelivered },
        stagedPrompt
      })
    ).resolves.toEqual({ delivered: false, failureNotified: false, inComposer: true })

    expect(onPromptDelivered).not.toHaveBeenCalled()
    expect(draft()).toBe('review this')
  })

  // The launch prompt is the chat's first message: drawn as sending from the click, nothing typed
  // while the chat starts goes out ahead of it, and it goes out once the chat exists.
  it('holds the chat for its prompt from the click, then sends that prompt first, once', async () => {
    const stagedPrompt = stageStructuredLaunchPrompt(SESSION, 'review this')
    expect(pendingTexts()).toEqual(['review this:sending'])
    expect(
      sendStructuredAgentSessionMessage({ sessionId: SESSION, target, text: 'typed meanwhile' })
    ).toBeNull()
    expect(sends()).toHaveLength(0)

    let receive = (_receipt: { sessionId: string; fence: number }): void => {}
    const settled = settleStructuredAgentLaunchPrompt({
      launchResult: new Promise((resolve) => (receive = resolve)),
      target,
      options: { prompt: 'review this' },
      stagedPrompt
    })
    receive({ sessionId: SESSION, fence: 1 })
    await expect(settled).resolves.toEqual({ delivered: true, failureNotified: false })
    expect(sends()).toHaveLength(1)
    expect(JSON.stringify(sends()[0])).toContain('review this')
    expect(
      sendStructuredAgentSessionMessage({ sessionId: SESSION, target, text: 'typed after' })
    ).not.toBeNull()
  })

  it('gives the chat back its send slot when the launch is cancelled, sending nothing', () => {
    stageStructuredLaunchPrompt(SESSION, 'review this')
    discardStructuredLaunchPrompts(SESSION)
    expect(pendingTexts()).toEqual([])
    expect(sends()).toHaveLength(0)
  })

  it('reports nothing for a draft, which the composer adopts instead', () => {
    expect(
      settleStructuredAgentLaunchPrompt({
        launchResult: Promise.resolve({ sessionId: SESSION, fence: 1 }),
        target,
        options: { prompt: 'review this', promptDelivery: 'draft' },
        stagedPrompt: null
      })
    ).toBeUndefined()
  })
})
