// @vitest-environment happy-dom

// A message the chat said was not sent, with a Retry beside it, waits for that Retry. The hold is
// read from the saved message, so quitting and reopening Orca (a new mount over the same storage)
// holds it exactly as the refusal did.

import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AGENT_SESSION_ACCEPTED_SEND_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import type { AgentSessionWireRefusalCode } from '../../../../shared/agent-session-wire'

const mocks = vi.hoisted(() => ({ call: vi.fn() }))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call
}))

import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/local-runtime-capabilities'
import { RuntimeRpcCallError } from '@/runtime/runtime-rpc-result'
import { agentJournalSubmissionKey } from '../../../../shared/agent-session-journal-item-key'
import { useStructuredAgentSessionOutbox } from './use-structured-agent-session-outbox'
import {
  clearNativeChatDraftCacheForTests,
  readNativeChatDraftCache
} from './native-chat-draft-cache'
import { STRUCTURED_AGENT_SESSION_EXPIRED_SEND_NOTICE } from '../../../../shared/structured-agent-session-send-disposition'
import { structuredAgentSessionDeliveryNotices } from './structured-agent-session-delivery-notices'

const SESSION = 'session-1'
const NEWER_ORCA_WORDS =
  'Chats were saved by a newer Orca. Your message was not sent. Update Orca to keep using them.'

type SendRequest = {
  body?: { blocks?: { text?: string }[] }
  envelope?: { clientOperationId?: string }
}

function requestId(params: SendRequest | undefined): string {
  return String(params?.envelope?.clientOperationId)
}

function sentIds(): string[] {
  return mocks.call.mock.calls.map((call) => requestId(call[2]))
}

function newerOrcaRefusal() {
  return {
    ok: false,
    refusal: {
      code: 'agent_session_journal_unreadable',
      message: 'Chats were saved by a newer Orca. Update Orca to keep using them.',
      details: { reason: 'journalWrittenByNewerOrca' }
    }
  }
}

function refusal(code: AgentSessionWireRefusalCode) {
  return { ok: false, refusal: { code, message: code } }
}

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
        providerItemId: `provider-${clientMessageId}`,
        reason: null,
        submittedAt: 1,
        resolvedAt: 1
      }
    }
  }
}

function hostAccepts(): void {
  mocks.call.mockImplementation((_target, _method, params: SendRequest) =>
    Promise.resolve(accepted(requestId(params)))
  )
}

function mount(fence = 1) {
  return renderHook(
    ({ fence: current }: { fence: number }) =>
      useStructuredAgentSessionOutbox({
        sessionId: SESSION,
        target: { kind: 'local' },
        fence: current,
        submissions: []
      }),
    { initialProps: { fence } }
  )
}

type Outbox = ReturnType<typeof mount>['result']['current']

function notices(outbox: Outbox) {
  return structuredAgentSessionDeliveryNotices(outbox.outbox, 'Claude', outbox.retry, [], [])
}

function noticeFor(outbox: Outbox, clientMessageId: string) {
  return notices(outbox).get(agentJournalSubmissionKey(clientMessageId))
}

/** Long enough for any effect a mount or a state change schedules to have sent. */
async function settle(): Promise<void> {
  await act(() => new Promise<void>((resolve) => setTimeout(resolve, 50)))
}

describe('a message the host refused, across a relaunch', () => {
  afterEach(() => {
    cleanup()
    setLocalRuntimeCapabilitiesForTests(null)
  })

  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    setLocalRuntimeCapabilitiesForTests([AGENT_SESSION_ACCEPTED_SEND_RUNTIME_CAPABILITY])
  })

  it.each(['returned', 'thrown'] as const)(
    'is not sent on its own after a relaunch; its Retry sends it (refusal %s)',
    async (shape) => {
      if (shape === 'returned') {
        mocks.call.mockResolvedValueOnce(newerOrcaRefusal())
      } else {
        // As `mapRuntimeError` sends a thrown refusal (pinned in `rpc/errors.test.ts`).
        mocks.call.mockRejectedValueOnce(
          new RuntimeRpcCallError({
            id: 'req-1',
            ok: false,
            error: {
              code: 'runtime_error',
              message: 'agent_session_journal_unreadable',
              data: {
                refusal: {
                  code: 'agent_session_journal_unreadable',
                  details: { reason: 'journalWrittenByNewerOrca' }
                }
              }
            }
          })
        )
      }
      const before = mount()
      act(() => expect(before.result.current.send('hello')).toBe(true))
      await waitFor(() => expect(before.result.current.outbox[0]?.lastFailure).toBeDefined())
      const refusedId = sentIds()[0]!
      expect(noticeFor(before.result.current, refusedId)?.text).toBe(NEWER_ORCA_WORDS)
      before.unmount()

      // The user updates Orca and opens the chat again; the host now takes sends.
      hostAccepts()
      const after = mount()
      await settle()
      expect(mocks.call).toHaveBeenCalledTimes(1)
      const notice = noticeFor(after.result.current, refusedId)
      expect(notice?.text).toBe(NEWER_ORCA_WORDS)
      expect(notice?.onRetry).toBeDefined()

      act(() => notice?.onRetry?.())
      await waitFor(() => expect(after.result.current.outbox).toHaveLength(0))
      // The refusal recorded nothing, so the Retry goes out under the refused id.
      expect(sentIds()).toEqual([refusedId, refusedId])
    }
  )

  it('sends a message typed again after a refusal once, not a second time after a relaunch', async () => {
    // The chat's history is from a newer Orca: every send is refused until the user updates.
    mocks.call.mockResolvedValue(newerOrcaRefusal())
    const before = mount()
    act(() => expect(before.result.current.send('hello')).toBe(true))
    await waitFor(() => expect(before.result.current.outbox[0]?.lastFailure).toBeDefined())
    // The user types the same message again rather than pressing Retry.
    act(() => expect(before.result.current.send('hello')).toBe(true))
    await settle()
    const refusedBeforeUpdate = mocks.call.mock.calls.length
    before.unmount()

    hostAccepts()
    const after = mount()
    await settle()
    // Nothing goes out on its own: each message still says it was not sent, with its own Retry.
    expect(mocks.call).toHaveBeenCalledTimes(refusedBeforeUpdate)
    expect(after.result.current.outbox).toHaveLength(2)
    for (const entry of after.result.current.outbox) {
      expect(noticeFor(after.result.current, entry.clientMessageId)?.onRetry).toBeDefined()
    }

    // One Retry delivers the message once; the other copy stays unsent.
    act(() => after.result.current.retry(after.result.current.outbox[1]!.clientMessageId))
    await waitFor(() => expect(after.result.current.outbox).toHaveLength(1))
    await settle()
    expect(mocks.call).toHaveBeenCalledTimes(refusedBeforeUpdate + 1)
  })

  it('keeps a send that never reached the host held across a relaunch', async () => {
    mocks.call.mockRejectedValueOnce(new Error('send failed'))
    const before = mount()
    act(() => expect(before.result.current.send('hello')).toBe(true))
    await waitFor(() =>
      expect(before.result.current.outbox[0]?.lastFailure).toEqual({ kind: 'failed' })
    )
    const failedId = sentIds()[0]!
    before.unmount()

    hostAccepts()
    const after = mount()
    await settle()
    expect(mocks.call).toHaveBeenCalledTimes(1)
    expect(noticeFor(after.result.current, failedId)?.onRetry).toBeDefined()
  })

  it('holds a refused message an earlier Orca saved, in the shape that build writes', async () => {
    // Exactly what a build from before this hold leaves behind after the refusal: no new field.
    localStorage.setItem(
      `orca:desktopStructuredAgentSessionOutbox:v1:${SESSION}`,
      JSON.stringify([
        {
          clientMessageId: 'op-refused',
          sessionId: SESSION,
          body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hello' }] },
          previewUris: [],
          state: 'queued',
          queuedAt: 1,
          lastAttemptAt: 2,
          retryAfterUnknownSubmittedAt: null,
          lastFailure: {
            kind: 'refused',
            code: 'agent_session_journal_unreadable',
            details: { reason: 'journalWrittenByNewerOrca' }
          }
        }
      ])
    )
    hostAccepts()
    const { result } = mount()
    await settle()
    expect(mocks.call).not.toHaveBeenCalled()
    expect(noticeFor(result.current, 'op-refused')?.text).toBe(NEWER_ORCA_WORDS)
  })
})

// An older host restarts the agent inside a send and refuses it unrecorded when that fails; a new
// fence while the chat is open is still its word to send again. A relaunch is not.
describe('a message an older host refused, across a relaunch', () => {
  afterEach(() => {
    cleanup()
    setLocalRuntimeCapabilitiesForTests(null)
  })

  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    setLocalRuntimeCapabilitiesForTests([])
  })

  it('is not sent on its own when the chat reopens on a moved fence', async () => {
    mocks.call.mockResolvedValueOnce(refusal('agent_session_checkpoint_stale'))
    const before = mount(1)
    act(() => expect(before.result.current.send('hello')).toBe(true))
    await waitFor(() => expect(before.result.current.outbox[0]?.lastFailure).toBeDefined())
    before.unmount()

    hostAccepts()
    mount(3)
    await settle()
    expect(mocks.call).toHaveBeenCalledTimes(1)
  })

  it('still sends it again when the fence moves while the chat is open', async () => {
    hostAccepts()
    mocks.call.mockResolvedValueOnce(refusal('agent_session_checkpoint_stale'))
    const { result, rerender } = mount(1)
    act(() => expect(result.current.send('hello')).toBe(true))
    await waitFor(() => expect(result.current.outbox[0]?.lastFailure).toBeDefined())

    rerender({ fence: 3 })
    await waitFor(() => expect(result.current.outbox).toHaveLength(0))
    expect(sentIds()[1]).toBe(sentIds()[0])
  })
})

describe('a message whose send could not be saved before it went out', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    setLocalRuntimeCapabilitiesForTests(null)
  })

  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    setLocalRuntimeCapabilitiesForTests([AGENT_SESSION_ACCEPTED_SEND_RUNTIME_CAPABILITY])
  })

  it('waits for its Retry, and does not hold back the next message', async () => {
    hostAccepts()
    const save = localStorage.setItem.bind(localStorage)
    // The send saves; the save that marks it on its way out fails.
    const setItem = vi
      .spyOn(localStorage, 'setItem')
      .mockImplementationOnce(save)
      .mockImplementationOnce(() => {
        throw new Error('storage full')
      })
    const { result } = mount()
    act(() => expect(result.current.send('first')).toBe(true))
    await waitFor(() =>
      expect(result.current.error).toBe('Message could not be saved to the outbox')
    )
    setItem.mockRestore()
    const firstId = result.current.outbox[0]!.clientMessageId

    act(() => expect(result.current.send('second')).toBe(true))
    await waitFor(() => expect(result.current.outbox).toHaveLength(1))
    await settle()
    expect(mocks.call).toHaveBeenCalledOnce()
    expect(sentIds()).not.toContain(firstId)
    expect(noticeFor(result.current, firstId)?.onRetry).toBeDefined()
  })
})

// A host forgets an operation id a day after it was made; after that the kept id is refused for
// good, and a new one could deliver a message an earlier attempt already delivered.
describe('a held message retried after its id expired', () => {
  afterEach(() => {
    cleanup()
    setLocalRuntimeCapabilitiesForTests(null)
  })

  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    clearNativeChatDraftCacheForTests()
    setLocalRuntimeCapabilitiesForTests([AGENT_SESSION_ACCEPTED_SEND_RUNTIME_CAPABILITY])
  })

  it('goes back to the composer with a notice, and is not sent again', async () => {
    mocks.call.mockResolvedValueOnce(newerOrcaRefusal())
    mocks.call.mockResolvedValue({
      ok: false,
      refusal: {
        code: 'agent_session_operation_expired',
        message: 'Operation expired.',
        details: { reason: 'operationExpired' }
      }
    })
    const { result } = renderHook(() =>
      useStructuredAgentSessionOutbox({
        sessionId: SESSION,
        target: { kind: 'local' },
        fence: 1,
        submissions: [],
        composerScopeKey: 'pane-1'
      })
    )
    act(() => expect(result.current.send('hello')).toBe(true))
    await waitFor(() => expect(result.current.outbox[0]?.lastFailure).toBeDefined())

    act(() => result.current.retry(result.current.outbox[0]!.clientMessageId))
    await waitFor(() => expect(result.current.outbox).toHaveLength(0))
    expect(readNativeChatDraftCache('pane-1')).toBe('hello')
    expect(result.current.error).toBe(STRUCTURED_AGENT_SESSION_EXPIRED_SEND_NOTICE)
    await settle()
    expect(mocks.call).toHaveBeenCalledTimes(2)
  })
})
