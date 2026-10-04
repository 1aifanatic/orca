// @vitest-environment happy-dom

import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AGENT_SESSION_SEND_ANSWERS_PROOF_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import {
  enqueueStructuredAgentSessionLaunchPrompt,
  getStructuredAgentSessionOutbox
} from '@/components/native-chat/structured-agent-session-outbox-storage'
import { structuredAgentSessionDraftScopeKey } from '@/components/native-chat/native-chat-composer-draft-store'
import {
  clearNativeChatDraftCacheForTests,
  readNativeChatDraftCache
} from '@/components/native-chat/native-chat-draft-cache'
import { resetStructuredAgentSessionChatLinesForTests } from '@/components/native-chat/structured-agent-session-returned-send'

const mocks = vi.hoisted(() => ({ call: vi.fn() }))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call
}))

import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/local-runtime-capabilities'
import { useStructuredAgentSessionOutbox } from '@/components/native-chat/use-structured-agent-session-outbox'
import { settleStructuredAgentLaunchPrompt } from './structured-agent-session-launch-prompt'

type SentParams = { envelope: { clientOperationId: string } }

function accepted(clientMessageId: string) {
  return {
    ok: true,
    replayed: false,
    fence: 1,
    cursor: { epoch: 'epoch-1', sequence: 2 },
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
        resolvedAt: 1
      }
    }
  }
}

/** The chat open on the session: its outbox resends a send with no answer under the same id. */
function mountChat(): void {
  renderHook(() =>
    useStructuredAgentSessionOutbox({
      sessionId: 'session-1',
      target: { kind: 'local' },
      fence: 1,
      submissions: [],
      journalCursor: { epoch: 'epoch-1', sequence: 1 }
    })
  )
}

afterEach(() => {
  cleanup()
  setLocalRuntimeCapabilitiesForTests(null)
})

describe('settleStructuredAgentLaunchPrompt', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    clearNativeChatDraftCacheForTests()
    resetStructuredAgentSessionChatLinesForTests()
    setLocalRuntimeCapabilitiesForTests([AGENT_SESSION_SEND_ANSWERS_PROOF_RUNTIME_CAPABILITY])
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
  // With no answer the open chat keeps sending it, so the caller waits for how it finally ends:
  // offering the prompt again meanwhile could send it twice.
  it('waits through a resend when the first send throws, and reports the delivery once', async () => {
    const stagedEntry = enqueueStructuredAgentSessionLaunchPrompt('session-1', 'review this')
    const onPromptDelivered = vi.fn()
    let calls = 0
    mocks.call.mockImplementation(async (_target, _method, params: SentParams) => {
      calls += 1
      if (calls === 1) {
        throw new Error('socket closed')
      }
      return accepted(params.envelope.clientOperationId)
    })
    let result: unknown = 'unsettled'
    void settleStructuredAgentLaunchPrompt({
      launchResult: Promise.resolve({ sessionId: 'session-1', fence: 1 }),
      target: { kind: 'local' },
      options: { prompt: 'review this', onPromptDelivered },
      stagedEntry
    })?.then((settled) => {
      result = settled
    })
    await vi.waitFor(() =>
      expect(getStructuredAgentSessionOutbox('session-1')).toMatchObject([{ state: 'unconfirmed' }])
    )
    expect(onPromptDelivered).not.toHaveBeenCalled()
    expect(result).toBe('unsettled')

    // The open chat resends it under its id.
    mountChat()
    await vi.waitFor(() => expect(result).toEqual({ delivered: true, failureNotified: false }), {
      timeout: 3000
    })
    expect(onPromptDelivered).toHaveBeenCalledOnce()
    expect(calls).toBe(2)
  })

  it('reports a prompt whose resend was refused as given back, and never as delivered', async () => {
    const stagedEntry = enqueueStructuredAgentSessionLaunchPrompt('session-1', 'review this')
    const onPromptDelivered = vi.fn()
    let calls = 0
    mocks.call.mockImplementation(async () => {
      calls += 1
      if (calls === 1) {
        throw new Error('socket closed')
      }
      return { ok: false, refusal: { code: 'agent_session_journal_unreadable', message: 'x' } }
    })
    const settled = settleStructuredAgentLaunchPrompt({
      launchResult: Promise.resolve({ sessionId: 'session-1', fence: 1 }),
      target: { kind: 'local' },
      options: { prompt: 'review this', onPromptDelivered },
      stagedEntry
    })
    await vi.waitFor(() =>
      expect(getStructuredAgentSessionOutbox('session-1')).toMatchObject([{ state: 'unconfirmed' }])
    )
    mountChat()

    await expect(settled).resolves.toEqual({ delivered: false, failureNotified: true })
    expect(onPromptDelivered).not.toHaveBeenCalled()
    expect(readNativeChatDraftCache(structuredAgentSessionDraftScopeKey('session-1'))).toBe(
      'review this'
    )
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
