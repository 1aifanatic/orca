// @vitest-environment happy-dom

// What one attempt may conclude: a stage that can't be saved never hands the message back, a first
// attempt stays first only while no other view staged the id again, and the queue holds behind an
// attempt until the write that settles it.

import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createStructuredAgentSessionOutboxEntry,
  type StructuredAgentSessionOutboxEntry
} from '../../../../shared/structured-agent-session-outbox'
import type * as HostCapability from '@/runtime/structured-agent-session-host-capability'

type SentParams = { envelope: { clientOperationId: string }; body: { blocks: { text?: string }[] } }

const mocks = vi.hoisted(() => ({
  call: vi.fn<(target: unknown, method: string, params: SentParams) => Promise<unknown>>(),
  answersProve: vi.fn<() => Promise<boolean>>()
}))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call
}))

vi.mock('@/runtime/structured-agent-session-host-capability', async (importOriginal) => ({
  ...(await importOriginal<typeof HostCapability>()),
  structuredAgentSessionHostAnswersProve: mocks.answersProve
}))

import { sendStructuredAgentSessionOutboxEntry } from './structured-agent-session-outbox-dispatch'
import { useStructuredAgentSessionOutbox } from './use-structured-agent-session-outbox'
import {
  getStructuredAgentSessionOutbox,
  readOutbox,
  writeOutbox
} from './structured-agent-session-outbox-storage'
import {
  nativeChatComposerDraftWritesSettled,
  structuredAgentSessionDraftScopeKey
} from './native-chat-composer-draft-store'
import {
  clearNativeChatDraftCacheForTests,
  readNativeChatDraftCache
} from './native-chat-draft-cache'
import { resetStructuredAgentSessionChatLinesForTests } from './structured-agent-session-returned-send'

const TARGET = { kind: 'local' } as const
const SCOPE = structuredAgentSessionDraftScopeKey('session-1')
const REFUSED = {
  ok: false,
  refusal: { code: 'agent_session_operation_capacity', message: 'busy' }
}

afterEach(cleanup)

// Why: a failed assertion must not leave storage refusing every later test's writes.
let restoreStorage = (): void => {}
afterEach(() => restoreStorage())

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  clearNativeChatDraftCacheForTests()
  resetStructuredAgentSessionChatLinesForTests()
  mocks.answersProve.mockResolvedValue(false)
})

function entry(
  clientMessageId: string,
  text: string,
  patch: Partial<StructuredAgentSessionOutboxEntry> = {}
): StructuredAgentSessionOutboxEntry {
  return {
    ...createStructuredAgentSessionOutboxEntry({
      clientMessageId,
      sessionId: 'session-1',
      text,
      attachments: [],
      queuedAt: 1
    }),
    ...patch
  }
}

function ACCEPTED(clientMessageId: string) {
  return {
    ok: true,
    replayed: false,
    fence: 1,
    cursor: { epoch: 'e', sequence: 2 },
    value: {
      clientMessageId,
      submission: {
        clientMessageId,
        fence: 1,
        payloadFingerprint: 'fp',
        dispatchState: 'accepted',
        providerItemId: null,
        reason: null,
        submittedAt: 1,
        resolvedAt: 1
      }
    }
  }
}

function mountOutbox() {
  return renderHook(() =>
    useStructuredAgentSessionOutbox({
      sessionId: 'session-1',
      target: TARGET,
      fence: 1,
      submissions: [],
      journalCursor: { epoch: 'e', sequence: 1 }
    })
  )
}

function send(next: StructuredAgentSessionOutboxEntry) {
  return sendStructuredAgentSessionOutboxEntry({
    next,
    entries: getStructuredAgentSessionOutbox('session-1'),
    target: TARGET,
    fence: 1,
    isCurrent: () => true
  })
}

/** Lets each hand-back finish: its draft saved, it leaves the outbox and ends. */
async function handBacksSettled(): Promise<void> {
  await act(async () => {
    await nativeChatComposerDraftWritesSettled()
    await Promise.resolve()
  })
}

describe('a stage that cannot be saved', () => {
  it('keeps the message in doubt for the probe to try again, saying it was not saved and is retried', async () => {
    expect(writeOutbox('session-1', [entry('resent', 'resent text', { lastAttemptAt: 5 })])).toBe(
      true
    )
    mocks.call.mockResolvedValue(ACCEPTED('resent'))
    const setItem = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })
    restoreStorage = () => setItem.mockRestore()
    const { result } = mountOutbox()

    await waitFor(() => expect(result.current.outbox[0]?.state).toBe('unconfirmed'))
    expect(mocks.call).not.toHaveBeenCalled()
    // An earlier attempt may have landed: handing it back could send it twice.
    expect(readNativeChatDraftCache(SCOPE)).toBe('')
    expect(readOutbox('session-1', { recoverDispatching: false })).toMatchObject([
      { clientMessageId: 'resent' }
    ])
    // Orca tries again on its own, so the line asks nothing of the person and says so.
    expect(result.current.error).toBe(
      "Couldn't save your message. Orca will keep trying to send it."
    )

    setItem.mockRestore()
    await waitFor(() => expect(result.current.outbox).toEqual([]), { timeout: 3000 })
    expect(mocks.call).toHaveBeenCalledOnce()
    expect(result.current.error).toBeNull()
  })
})

describe('a Stop that withdraws a message the chat line is about', () => {
  it('clears the line with the message it takes back', async () => {
    const save = localStorage.setItem.bind(localStorage)
    let full = false
    const setItem = vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
      if (full) {
        throw new Error('QuotaExceededError')
      }
      save(key, value)
    })
    restoreStorage = () => setItem.mockRestore()
    const { result } = mountOutbox()
    act(() => {
      expect(result.current.send('never went out')).toBe(true)
      // Storage fills after the append: the stage is what can't be saved.
      full = true
    })
    await waitFor(() => expect(result.current.error).not.toBeNull())
    full = false

    act(() => result.current.stop('stop-1'))
    await handBacksSettled()
    expect(result.current.outbox).toEqual([])
    expect(readNativeChatDraftCache(SCOPE)).toBe('never went out')
    expect(result.current.error).toBeNull()
  })
})

describe('a first attempt', () => {
  it('is no longer first once another view staged the id again before the answer came', async () => {
    const first = entry('first', 'first text')
    expect(writeOutbox('session-1', [first])).toBe(true)
    mocks.call.mockImplementation(async () => {
      // Another window restages the same id meanwhile, and its attempt may land.
      writeOutbox('session-1', [{ ...first, state: 'dispatching', lastAttemptAt: 99 }])
      return REFUSED
    })

    let settlement: Awaited<ReturnType<typeof send>> = null
    await act(async () => {
      settlement = await send(first)
    })

    expect(settlement).toMatchObject({ kind: 'unanswered' })
    expect(mocks.answersProve).toHaveBeenCalledOnce()
    expect(readNativeChatDraftCache(SCOPE)).toBe('')
  })

  it('still proves no record when it was the only attempt', async () => {
    const first = entry('first', 'first text')
    expect(writeOutbox('session-1', [first])).toBe(true)
    mocks.call.mockResolvedValue(REFUSED)

    await act(async () => {
      await send(first)
    })

    expect(mocks.answersProve).not.toHaveBeenCalled()
    expect(readNativeChatDraftCache(SCOPE)).toBe('first text')
  })
})

describe('single-flight', () => {
  it('holds the queue through the capability probe, so a later send never overtakes the head', async () => {
    const probe = Promise.withResolvers<boolean>()
    mocks.answersProve.mockImplementation(() => probe.promise)
    expect(writeOutbox('session-1', [entry('head', 'head', { lastAttemptAt: 5 })])).toBe(true)
    mocks.call.mockImplementation(async (_target, _method, params) =>
      params.envelope.clientOperationId === 'head'
        ? REFUSED
        : ACCEPTED(params.envelope.clientOperationId)
    )
    const { result } = mountOutbox()
    await waitFor(() => expect(mocks.answersProve).toHaveBeenCalledOnce())

    act(() => expect(result.current.send('later')).toBe(true))
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)))
    expect(mocks.call).toHaveBeenCalledOnce()

    await act(async () => {
      probe.resolve(true)
    })
    await waitFor(() => expect(result.current.outbox).toEqual([]))
    expect(mocks.call.mock.calls.map((call) => call[2].body.blocks[0]?.text)).toEqual([
      'head',
      'later'
    ])
    expect(readNativeChatDraftCache(SCOPE)).toBe('head')
  })
})
