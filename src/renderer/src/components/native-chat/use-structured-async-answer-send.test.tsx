// A card answer is an outbox entry with a card origin. Its wait ends on every way the entry can
// leave, and nothing it does touches the composer draft.

// @vitest-environment happy-dom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalSubmission } from '../../../../shared/agent-session-journal-types'
import type { NativeChatAsyncAnswerOutcome } from '../../../../shared/native-chat-async-question-answers'
import { DISPATCH_REJECTED_CANCELLED } from '../../../../shared/structured-agent-session-dispatch-rejection'

type SendParams = { envelope?: { clientOperationId: string } }

const mocks = vi.hoisted(() => ({
  call: vi.fn<(target: unknown, method: string, params: SendParams) => Promise<unknown>>()
}))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call,
  supportsStructuredAgentSessionPromptCancel: vi.fn(async () => false)
}))

import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/local-runtime-capabilities'
import {
  clearNativeChatDraftCacheForTests,
  readNativeChatDraftCache,
  writeNativeChatDraftCache
} from './native-chat-draft-cache'
import { useStructuredAgentSessionOutbox } from './use-structured-agent-session-outbox'
import { useStructuredAsyncAnswerSend } from './use-structured-async-answer-send'

const SESSION = 'session-async'
const PANE = 'tab-1::session-async'
const target = { kind: 'local' } as const

type Props = {
  submissions: AgentJournalSubmission[]
  fence: number | null
  queuedMessageIds?: string[]
}

function submission(
  clientMessageId: string,
  overrides: Partial<AgentJournalSubmission> = {}
): AgentJournalSubmission {
  return {
    clientMessageId,
    fence: 1,
    payloadFingerprint: 'fingerprint',
    dispatchState: 'pending',
    providerItemId: null,
    reason: null,
    submittedAt: 10,
    resolvedAt: null,
    ...overrides
  }
}

function render(initial: Props) {
  return renderHook(
    (props: Props) => {
      const outbox = useStructuredAgentSessionOutbox({
        sessionId: SESSION,
        target,
        fence: props.fence,
        submissions: props.submissions,
        journalItems: [],
        composerScopeKey: PANE,
        ...(props.queuedMessageIds ? { queuedMessageIds: props.queuedMessageIds } : {})
      })
      const send = useStructuredAsyncAnswerSend({
        sessionId: SESSION,
        sendAsyncAnswer: outbox.sendAsyncAnswer,
        outbox: outbox.outbox,
        submissions: props.submissions,
        queuedMessageIds: props.queuedMessageIds
      })
      return { outbox, send }
    },
    { initialProps: initial }
  )
}

function answer(result: { current: { send: ReturnType<typeof useStructuredAsyncAnswerSend> } }) {
  let settled: NativeChatAsyncAnswerOutcome | null = null
  act(() => {
    void result.current.send('Question: A?\nAnswer: yes', { a: 'yes' }).then((outcome) => {
      settled = outcome
    })
  })
  return () => settled
}

function hangSends(): void {
  mocks.call.mockImplementation(() => new Promise(() => {}))
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  clearNativeChatDraftCacheForTests()
  let uuid = 0
  vi.spyOn(globalThis.crypto, 'randomUUID').mockImplementation(() => {
    uuid += 1
    return `22222222-2222-4222-8222-${uuid.toString(16).padStart(12, '0')}`
  })
})

afterEach(() => {
  cleanup()
  setLocalRuntimeCapabilitiesForTests(null)
})

describe('structured async answers', () => {
  it('carries its card origin and never touches the composer draft', () => {
    hangSends()
    writeNativeChatDraftCache(PANE, 'half-typed')
    const { result } = render({ submissions: [], fence: null })
    answer(result)
    expect(result.current.outbox.outbox[0]).toMatchObject({
      origin: { kind: 'async-answer', edits: { a: 'yes' } }
    })
    expect(readNativeChatDraftCache(PANE)).toBe('half-typed')
  })

  it('ends as withdrawn on a Stop before dispatch, leaving the draft as it was', async () => {
    hangSends()
    writeNativeChatDraftCache(PANE, 'half-typed')
    const { result, rerender } = render({ submissions: [], fence: null })
    const settled = answer(result)
    act(() => result.current.outbox.withdrawUnsent())
    rerender({ submissions: [], fence: null })
    await waitFor(() => expect(settled()).toBe('withdrawn'))
    expect(readNativeChatDraftCache(PANE)).toBe('half-typed')
  })

  it('ends as withdrawn when the host withdrew it, without restoring it to the composer', async () => {
    hangSends()
    writeNativeChatDraftCache(PANE, 'half-typed')
    const { result, rerender } = render({ submissions: [], fence: null })
    const settled = answer(result)
    const id = result.current.outbox.outbox[0]!.clientMessageId
    rerender({
      fence: 1,
      submissions: [
        submission(id, { dispatchState: 'rejected', reason: DISPATCH_REJECTED_CANCELLED })
      ]
    })
    await waitFor(() => expect(settled()).toBe('withdrawn'))
    expect(readNativeChatDraftCache(PANE)).toBe('half-typed')
  })

  it('ends as queued when the host queue takes ownership before any acknowledgement', async () => {
    hangSends()
    const { result, rerender } = render({ submissions: [], fence: null })
    const settled = answer(result)
    const id = result.current.outbox.outbox[0]!.clientMessageId
    rerender({ submissions: [], fence: null, queuedMessageIds: [id] })
    await waitFor(() => expect(settled()).toBe('queued'))
  })

  it('stays in flight while a direct send awaits the provider, then ends accepted', async () => {
    hangSends()
    const { result, rerender } = render({ submissions: [], fence: null })
    const settled = answer(result)
    const id = result.current.outbox.outbox[0]!.clientMessageId
    rerender({ submissions: [submission(id)], fence: null })
    await act(async () => {
      await Promise.resolve()
    })
    expect(settled()).toBeNull()
    rerender({ submissions: [submission(id, { dispatchState: 'accepted' })], fence: null })
    await waitFor(() => expect(settled()).toBe('accepted'))
  })

  it('ends as accepted when the send is answered accepted before its row arrives', async () => {
    mocks.call.mockImplementation(async (_target, method, params) => {
      if (method !== 'agentSession.send') {
        return null
      }
      const id = params.envelope?.clientOperationId ?? ''
      return {
        ok: true,
        replayed: false,
        fence: 1,
        cursor: { epoch: 'e', sequence: 2 },
        value: { clientMessageId: id, submission: submission(id, { dispatchState: 'accepted' }) }
      }
    })
    const { result } = render({ submissions: [], fence: 1 })
    const settled = answer(result)
    await waitFor(() => expect(settled()).toBe('accepted'))
  })

  it('ends as unknown when an owner change puts the answer back in the queue', async () => {
    hangSends()
    const { result, rerender } = render({ submissions: [], fence: 1 })
    const settled = answer(result)
    await waitFor(() => expect(result.current.outbox.outbox[0]?.state).toBe('dispatching'))
    rerender({ submissions: [], fence: 2 })
    await waitFor(() => expect(settled()).toBe('unknown'))
  })

  it('ends as rejected when the dispatch is refused', async () => {
    mocks.call.mockImplementation(async (_target, method) =>
      method === 'agentSession.send'
        ? { ok: false, error: { code: 'invalid_params', message: 'refused' } }
        : null
    )
    const { result } = render({ submissions: [], fence: 1 })
    const settled = answer(result)
    await waitFor(() => expect(settled()).toBe('rejected'))
  })

  it('ends as unknown when the pane goes away mid-flight', async () => {
    hangSends()
    const { result, unmount } = render({ submissions: [], fence: null })
    const settled = answer(result)
    unmount()
    await waitFor(() => expect(settled()).toBe('unknown'))
  })
})
