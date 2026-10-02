// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  enqueueStructuredAgentSessionLaunchPrompt,
  getStructuredAgentSessionOutbox,
  mutateStructuredAgentSessionLaunchPrompt
} from '@/components/native-chat/structured-agent-session-outbox-storage'
import { structuredAgentSessionDeliveryNotices } from '@/components/native-chat/structured-agent-session-delivery-notices'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'

const mocks = vi.hoisted(() => ({ call: vi.fn(), subscribe: vi.fn() }))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call,
  subscribeStructuredAgentSession: mocks.subscribe
}))

import { settleStructuredAgentLaunchPrompt } from './structured-agent-session-launch-prompt'
import { awaitStructuredLaunchPromptTaken } from './structured-agent-session-launch-prompt-handover'
import {
  FIRST_START_FAILS,
  firstMessageStream,
  play
} from './structured-agent-session-launch-prompt-test-support'

function launch(onPromptDelivered = vi.fn()) {
  const stagedEntry = enqueueStructuredAgentSessionLaunchPrompt('session-1', 'review this')
  const stream = firstMessageStream(mocks, stagedEntry!.clientMessageId)
  const result = settleStructuredAgentLaunchPrompt({
    launchResult: Promise.resolve({ sessionId: 'session-1', fence: 1 }),
    options: { prompt: 'review this', onPromptDelivered },
    stagedEntry
  })
  return { stagedEntry, stream, result: result!, onPromptDelivered }
}

describe('settleStructuredAgentLaunchPrompt', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(
      '11111111-1111-4111-8111-111111111111'
    )
  })

  it('reports a launch prompt delivered only once the agent a retried start brought up takes it', async () => {
    const { stream, result, onPromptDelivered } = launch()
    const host = await stream
    const [retry, handedOver, accepted] = FIRST_START_FAILS.retriedThenTaken

    host.next(retry!)
    host.next(handedOver!)
    await Promise.resolve()
    // Still waiting: nothing outward has happened, and the entry waits for the provider echo.
    expect(onPromptDelivered).not.toHaveBeenCalled()
    const persisted = JSON.parse(localStorage.getItem(localStorage.key(0)!) ?? '[]') as {
      state: string
    }[]
    expect(persisted).toMatchObject([{ state: 'dispatching' }])

    host.next(accepted!)
    await expect(result).resolves.toEqual({ delivered: true, failureNotified: false })
    expect(onPromptDelivered).toHaveBeenCalledOnce()
    expect(host.open()).toBe(false)
  })

  it.each([
    ['rejected after its tries', FIRST_START_FAILS.rejectedAfterTries],
    ['withdrawn when its chat closes mid-wait', FIRST_START_FAILS.chatClosed]
  ])('reports a launch prompt %s undelivered', async (_case, outcome) => {
    const { stream, result, onPromptDelivered } = launch()
    play(await stream, outcome)

    await expect(result).resolves.toEqual({ delivered: false, failureNotified: false })
    expect(onPromptDelivered).not.toHaveBeenCalled()
  })

  it('keeps waiting through an unknown answer that a late echo then proves taken', async () => {
    const { stream, result, onPromptDelivered } = launch()
    const host = await stream
    const [handedOver, unknown, accepted] = FIRST_START_FAILS.unknownThenTaken
    host.next(handedOver!)
    host.next(unknown!)
    await Promise.resolve()
    expect(onPromptDelivered).not.toHaveBeenCalled()

    host.next(accepted!)
    await expect(result).resolves.toEqual({ delivered: true, failureNotified: false })
    expect(onPromptDelivered).toHaveBeenCalledOnce()
  })

  // The host's subscribe opens with a snapshot, which already carries a verdict reached in the gap
  // between the send's answer and the read.
  it.each([
    ['taken', { dispatchState: 'accepted' as const }, true],
    ['rejected', { dispatchState: 'rejected' as const, rejection: { kind: 'notSignedIn' } }, false]
  ])('answers a first message already %s when the read opens', async (state, opened, delivered) => {
    // Its own session, so no other case's read can answer for it.
    const sessionId = `session-opened-${state}`
    const stagedEntry = enqueueStructuredAgentSessionLaunchPrompt(sessionId, 'review this')
    const onPromptDelivered = vi.fn()
    void firstMessageStream(mocks, stagedEntry!.clientMessageId, opened)

    await expect(
      settleStructuredAgentLaunchPrompt({
        launchResult: Promise.resolve({ sessionId, fence: 1 }),
        options: { prompt: 'review this', onPromptDelivered },
        stagedEntry
      })
    ).resolves.toEqual({ delivered, failureNotified: false })
    expect(onPromptDelivered).toHaveBeenCalledTimes(delivered ? 1 : 0)
  })

  it('reports undelivered when the session stream fails before a verdict', async () => {
    const stagedEntry = enqueueStructuredAgentSessionLaunchPrompt('session-1', 'review this')
    void firstMessageStream(mocks, stagedEntry!.clientMessageId)
    mocks.subscribe.mockImplementation(async (_target, _params, _onEvent, onError) => {
      queueMicrotask(() => onError(new Error('stream closed')))
      return { unsubscribe: vi.fn() }
    })

    await expect(
      settleStructuredAgentLaunchPrompt({
        launchResult: Promise.resolve({ sessionId: 'session-1', fence: 1 }),
        options: { prompt: 'review this' },
        stagedEntry
      })
    ).resolves.toEqual({ delivered: false, failureNotified: false })
  })

  it('reads one launch prompt once, however many ask', async () => {
    const stream = firstMessageStream(mocks, 'message-1')
    const first = awaitStructuredLaunchPromptTaken('session-1', 'message-1')
    const second = awaitStructuredLaunchPromptTaken('session-1', 'message-1')
    play(await stream, FIRST_START_FAILS.retriedThenTaken)

    await expect(Promise.all([first, second])).resolves.toEqual([true, true])
    expect(mocks.subscribe).toHaveBeenCalledOnce()
  })

  it('drops the previous attempt failure when the launch path sends the message again', async () => {
    const stagedEntry = enqueueStructuredAgentSessionLaunchPrompt('session-1', 'review this')
    mutateStructuredAgentSessionLaunchPrompt(
      'session-1',
      stagedEntry!.clientMessageId,
      (entry) => ({
        ...entry,
        lastFailure: { kind: 'refused', code: 'agent_session_operation_capacity' }
      })
    )
    mocks.call.mockResolvedValue({
      ok: false,
      refusal: { code: 'agent_session_checkpoint_stale', message: 'stale' }
    })

    await settleStructuredAgentLaunchPrompt({
      launchResult: Promise.resolve({ sessionId: 'session-1', fence: 1 }),
      options: { prompt: 'review this' },
      stagedEntry
    })

    const persisted: unknown = JSON.parse(localStorage.getItem(localStorage.key(0)!) ?? '[]')
    expect(persisted).toHaveLength(1)
    expect(persisted).not.toContainEqual(
      expect.objectContaining({ lastFailure: expect.anything() })
    )
  })

  it('keeps why a launch prompt its caller holds was refused for good, so its notice says it', async () => {
    const stagedEntry = enqueueStructuredAgentSessionLaunchPrompt('session-1', 'review this', true)
    mocks.call.mockResolvedValue({
      ok: false,
      refusal: { code: 'agent_session_operation_invalid', message: 'invalid' }
    })

    await settleStructuredAgentLaunchPrompt({
      launchResult: Promise.resolve({ sessionId: 'session-1', fence: 1 }),
      options: { prompt: 'review this' },
      stagedEntry
    })

    const [refused] = getStructuredAgentSessionOutbox('session-1')
    expect(refused).toMatchObject({
      state: 'rejected',
      lastFailure: { kind: 'refused', code: 'agent_session_operation_invalid' }
    })
    const notice = structuredAgentSessionDeliveryNotices(
      [refused!],
      'Claude',
      vi.fn(),
      [],
      [],
      new Set()
    )
    expect(notice.get(agentJournalSubmissionKey(refused!.clientMessageId))?.text).not.toContain(
      'Message was not sent.'
    )
  })

  // Whatever the start's failure (signed out, not installed, the agent exiting as it started), it
  // ends as the message's rejection; nothing that writes on delivery may run.
})
