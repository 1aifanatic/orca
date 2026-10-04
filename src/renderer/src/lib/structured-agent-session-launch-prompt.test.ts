// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  enqueueStructuredAgentSessionLaunchPrompt,
  getStructuredAgentSessionOutbox
} from '@/components/native-chat/structured-agent-session-outbox-storage'
import { structuredAgentSessionDraftScopeKey } from '@/components/native-chat/native-chat-composer-draft-store'
import { readNativeChatDraftCache } from '@/components/native-chat/native-chat-draft-cache'

const mocks = vi.hoisted(() => ({ call: vi.fn() }))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call
}))

import { settleStructuredAgentLaunchPrompt } from './structured-agent-session-launch-prompt'

describe('settleStructuredAgentLaunchPrompt', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(
      '11111111-1111-4111-8111-111111111111'
    )
  })

  it('reports an admitted launch prompt delivered while retaining it for the provider echo', async () => {
    const stagedEntry = enqueueStructuredAgentSessionLaunchPrompt('session-1', 'review this')
    const onPromptDelivered = vi.fn()
    mocks.call.mockResolvedValue({
      ok: true,
      replayed: false,
      fence: 1,
      cursor: { epoch: 'epoch-1', sequence: 1 },
      value: {
        clientMessageId: stagedEntry!.clientMessageId,
        submission: {
          clientMessageId: stagedEntry!.clientMessageId,
          fence: 1,
          payloadFingerprint: 'fingerprint',
          dispatchState: 'pending',
          providerItemId: null,
          reason: null,
          submittedAt: 1,
          resolvedAt: null
        }
      }
    })

    await expect(
      settleStructuredAgentLaunchPrompt({
        launchResult: Promise.resolve({ sessionId: 'session-1', fence: 1 }),
        target: { kind: 'local' },
        options: { prompt: 'review this', onPromptDelivered },
        stagedEntry
      })
    ).resolves.toEqual({ delivered: true, failureNotified: false })

    expect(onPromptDelivered).toHaveBeenCalledOnce()
    const persisted = JSON.parse(localStorage.getItem(localStorage.key(0)!) ?? '[]') as {
      state: string
    }[]
    expect(persisted).toMatchObject([{ state: 'dispatching' }])
  })

  // The launch prompt goes through the outbox's one sender and settlement: a first attempt the
  // host refused comes back to the chat's draft, and the chat line says why, so the caller says
  // nothing more.
  it('gives a first launch prompt the host refused back to the chat draft, with no resend', async () => {
    const stagedEntry = enqueueStructuredAgentSessionLaunchPrompt('session-1', 'review this')
    const onPromptDelivered = vi.fn()
    mocks.call.mockResolvedValue({
      ok: false,
      refusal: { code: 'agent_session_checkpoint_stale', message: 'stale' }
    })

    await expect(
      settleStructuredAgentLaunchPrompt({
        launchResult: Promise.resolve({ sessionId: 'session-1', fence: 1 }),
        target: { kind: 'local' },
        options: { prompt: 'review this', onPromptDelivered },
        stagedEntry
      })
    ).resolves.toEqual({ delivered: false, failureNotified: true })

    expect(onPromptDelivered).not.toHaveBeenCalled()
    expect(mocks.call).toHaveBeenCalledOnce()
    expect(getStructuredAgentSessionOutbox('session-1')).toEqual([])
    expect(readNativeChatDraftCache(structuredAgentSessionDraftScopeKey('session-1'))).toBe(
      'review this'
    )
  })
  // The chat keeps it and sends it again: a caller offering it to copy would invite a duplicate.
  it('reports a launch prompt with no answer yet as handled by the chat', async () => {
    const stagedEntry = enqueueStructuredAgentSessionLaunchPrompt('session-1', 'review this')
    mocks.call.mockRejectedValue(new Error('socket closed'))

    await expect(
      settleStructuredAgentLaunchPrompt({
        launchResult: Promise.resolve({ sessionId: 'session-1', fence: 1 }),
        target: { kind: 'local' },
        options: { prompt: 'review this' },
        stagedEntry
      })
    ).resolves.toEqual({ delivered: false, failureNotified: true })
    expect(getStructuredAgentSessionOutbox('session-1')).toMatchObject([{ state: 'unconfirmed' }])
  })

  it('reports a launch prompt that never went out as not handled', async () => {
    const stagedEntry = enqueueStructuredAgentSessionLaunchPrompt('session-1', 'review this')
    localStorage.clear()

    await expect(
      settleStructuredAgentLaunchPrompt({
        launchResult: Promise.resolve({ sessionId: 'session-1', fence: 1 }),
        target: { kind: 'local' },
        options: { prompt: 'review this' },
        stagedEntry
      })
    ).resolves.toEqual({ delivered: false, failureNotified: false })
    expect(mocks.call).not.toHaveBeenCalled()
  })
})
