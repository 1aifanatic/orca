// @vitest-environment happy-dom

// A chat whose tab replaced another (a /clear) takes what this window still held for the old one:
// the composer's draft, and messages that never reached it. Derived from the host's tab link, so
// it holds whichever order the clear's reply and the tab move arrive in.

import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session-journal-types'
import {
  createStructuredAgentSessionOutboxEntry,
  stageStructuredAgentSessionOutboxEntryForSend,
  type StructuredAgentSessionOutboxEntry
} from '../../../../shared/structured-agent-session-outbox'
import {
  disposeStructuredAgentSessionSendFailure,
  disposeStructuredAgentSessionSendResult
} from '../../../../shared/structured-agent-session-send-disposition'
import type { AgentSessionWireRefusal } from '../../../../shared/agent-session-wire'

const mocks = vi.hoisted(() => ({
  call: vi.fn<(target: unknown, method: string, params: unknown) => Promise<unknown>>(
    async () => null
  )
}))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call
}))

import {
  clearNativeChatDraftCacheForTests,
  readNativeChatDraftCache,
  writeNativeChatDraftCache
} from './native-chat-draft-cache'
import {
  clearNativeChatComposerDraftIfUnchanged,
  hydrateNativeChatComposerDrafts,
  readNativeChatComposerDraft,
  structuredAgentSessionDraftScopeKey as scope
} from './native-chat-composer-draft-store'
import {
  createMemoryNativeChatComposerDraftStorage,
  setNativeChatComposerDraftStorageForTests
} from './native-chat-composer-draft-storage'
import { resetNativeChatComposerDraftLoadForTests } from './native-chat-composer-draft-load'
import {
  commitStructuredAgentSessionOutbox,
  getStructuredAgentSessionOutbox
} from './structured-agent-session-outbox-storage'
import { useStructuredAgentSessionOutbox } from './use-structured-agent-session-outbox'
import { AGENT_SESSION_SEND_ANSWERS_PROOF_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/local-runtime-capabilities'

const NO_ITEMS: readonly AgentJournalRenderItem[] = []
const CLEARED = "The chat was cleared before your message went out. It's back in the composer."
const NOT_SENT = "Your message wasn't sent. It's back in the composer."
const UNCONFIRMED =
  "Orca couldn't confirm your message reached the agent. Check the chat, then send it again if needed."

afterEach(() => {
  cleanup()
  setLocalRuntimeCapabilitiesForTests(null)
})

beforeEach(() => {
  vi.clearAllMocks()
  // The host's answers are proof, as current hosts advertise.
  setLocalRuntimeCapabilitiesForTests([AGENT_SESSION_SEND_ANSWERS_PROOF_RUNTIME_CAPABILITY])
  mocks.call.mockImplementation(async () => null)
  localStorage.clear()
  clearNativeChatDraftCacheForTests()
})

function pane(
  sessionId: string,
  options: {
    replaces?: string
    cards?: readonly string[]
    submissions?: readonly AgentJournalSubmission[]
  } = {}
) {
  return renderHook(() =>
    useStructuredAgentSessionOutbox({
      journalItems: NO_ITEMS,
      sessionId,
      target: { kind: 'local' },
      fence: 1,
      submissions: options.submissions ?? [],
      composerScopeKey: scope(sessionId),
      queuedMessageIds: options.cards ?? [],
      ...(options.replaces ? { replacesSessionId: options.replaces } : {})
    })
  )
}

function entry(
  id: string,
  text: string,
  overrides: Partial<StructuredAgentSessionOutboxEntry> = {}
): StructuredAgentSessionOutboxEntry {
  return {
    ...createStructuredAgentSessionOutboxEntry({
      clientMessageId: id,
      sessionId: 'old',
      text,
      attachments: [],
      queuedAt: Number(id.replace(/\D/g, '')) || 1
    }),
    ...overrides
  }
}

const CLEARED_REFUSAL: AgentSessionWireRefusal = {
  code: 'agent_session_operation_invalid',
  details: { reason: 'conversationCleared' },
  message: 'This conversation has been cleared. Use the current conversation.'
}

/** What the outbox saves when a send's own answer refuses it, through the real disposition:
 *  `attempts` 1 is a first attempt; 2 is a resend of one whose first answer was lost. */
function refusedSend(
  id: string,
  text: string,
  refusal: AgentSessionWireRefusal,
  attempts: 1 | 2 = 1
) {
  const sent = stageStructuredAgentSessionOutboxEntryForSend(entry(id, text), 5)
  const asked = attempts === 1 ? entry(id, text) : { ...sent, state: 'queued' as const }
  const disposition = disposeStructuredAgentSessionSendResult({
    entries: [attempts === 1 ? sent : stageStructuredAgentSessionOutboxEntryForSend(asked, 9)],
    entry: asked,
    result: { ok: false, refusal },
    createOperationId: () => `${id}-again`
  })
  return disposition.entries[0]!
}

/** A send whose request went out, then failed with an error the dispatcher can't read as "delivery
 *  unknown" (a remote "Timed out waiting…"): saved as a plain failure on an attempted entry. */
function failedAfterSend(id: string, text: string) {
  return disposeStructuredAgentSessionSendFailure({
    entries: [stageStructuredAgentSessionOutboxEntryForSend(entry(id, text), 5)],
    entry: entry(id, text),
    cause: new Error('Timed out waiting for the remote Orca runtime to respond.'),
    isDeliveryUnknown: () => false
  }).entries[0]!
}

describe('the /clear the composer sent', () => {
  it('never starts the new chat, when the tab moves before the reply', async () => {
    // The composer clears a command's text only once its reply lands.
    writeNativeChatDraftCache(scope('old'), '/clear')
    pane('new', { replaces: 'old' })
    // The carry has run: it took the old draft, and dropped it.
    await waitFor(() => expect(readNativeChatDraftCache(scope('old'))).toBe(''))
    expect(readNativeChatDraftCache(scope('new'))).toBe('')
    // The reply then lands on the old composer, which finds nothing to clear.
    clearNativeChatComposerDraftIfUnchanged(scope('old'), readNativeChatComposerDraft(scope('old')))
    expect(readNativeChatDraftCache(scope('new'))).toBe('')
  })

  it('never starts the new chat, when the reply lands first', async () => {
    writeNativeChatDraftCache(scope('old'), '/clear')
    clearNativeChatComposerDraftIfUnchanged(scope('old'), readNativeChatComposerDraft(scope('old')))
    pane('new', { replaces: 'old' })
    await act(async () => {
      await hydrateNativeChatComposerDrafts()
    })
    expect(readNativeChatDraftCache(scope('new'))).toBe('')
  })
})

describe('a draft typed in the chat a /clear replaced', () => {
  it('comes along after what the new chat already holds, and leaves the old one', async () => {
    writeNativeChatDraftCache(scope('old'), 'typed while the clear waited')
    writeNativeChatDraftCache(scope('new'), 'already here')
    pane('new', { replaces: 'old' })
    await waitFor(() => expect(readNativeChatDraftCache(scope('old'))).toBe(''))
    expect(readNativeChatDraftCache(scope('new'))).toBe(
      'already here\n\ntyped while the clear waited'
    )
    expect(readNativeChatDraftCache(scope('old'))).toBe('')
  })

  it('comes along for a pane first mounted on the new chat, and only once', async () => {
    writeNativeChatDraftCache(scope('old'), 'saved before a reload')
    const first = pane('new', { replaces: 'old' })
    await waitFor(() => expect(readNativeChatDraftCache(scope('old'))).toBe(''))
    first.unmount()
    pane('new', { replaces: 'old' })
    expect(readNativeChatDraftCache(scope('new'))).toBe('saved before a reload')
  })
})

/** The new chat's pane, whose link the overlay withholds while a tab shows the old chat again. */
function linkedPane(sessionId: string, replaces: string | undefined) {
  return renderHook(
    ({ link }: { link: string | undefined }) =>
      useStructuredAgentSessionOutbox({
        journalItems: NO_ITEMS,
        sessionId,
        target: { kind: 'local' },
        fence: 1,
        submissions: [],
        composerScopeKey: scope(sessionId),
        queuedMessageIds: [],
        ...(link ? { replacesSessionId: link } : {})
      }),
    { initialProps: { link: replaces } }
  )
}

describe('the chat a /clear replaced, reopened from history beside the new one', () => {
  it('keeps what is typed there; the carry at the clear happened once', async () => {
    writeNativeChatDraftCache(scope('old'), 'typed before the clear')
    const view = linkedPane('new', 'old')
    await waitFor(() => expect(readNativeChatDraftCache(scope('old'))).toBe(''))
    expect(readNativeChatDraftCache(scope('new'))).toBe('typed before the clear')
    // Reopened: its tab shows the old chat, so the new chat's still-mounted pane has no link.
    view.rerender({ link: undefined })
    for (const text of ['t', 'ty', 'typed in the reopened chat']) {
      act(() => writeNativeChatDraftCache(scope('old'), text))
    }
    await act(async () => {})
    expect(readNativeChatDraftCache(scope('old'))).toBe('typed in the reopened chat')
    expect(readNativeChatDraftCache(scope('new'))).toBe('typed before the clear')
    // Once no tab shows it, what it left follows the link here, once.
    view.rerender({ link: 'old' })
    await waitFor(() => expect(readNativeChatDraftCache(scope('old'))).toBe(''))
    expect(readNativeChatDraftCache(scope('new'))).toBe(
      'typed before the clear\n\ntyped in the reopened chat'
    )
  })

  it('keeps a message sent there; asking about one in doubt pauses, then starts afresh', async () => {
    // The first answer proves nothing, so it would be asked again shortly.
    mocks.call.mockResolvedValueOnce({
      ok: false,
      refusal: { code: 'agent_session_operation_expired', message: 'Expired.' }
    })
    const inDoubt = entry('m1', 'asked about', { state: 'unconfirmed', lastAttemptAt: 3 })
    commitStructuredAgentSessionOutbox('old', [inDoubt])
    const view = linkedPane('new', 'old')
    await waitFor(() => expect(mocks.call).toHaveBeenCalledOnce())
    await act(async () => {})
    view.rerender({ link: undefined })
    expect(view.result.current.askedRows).toEqual([])
    // Sent in the reopened chat and refused there as cleared: that chat's own row.
    const sentThere = refusedSend('m2', 'sent in the reopened chat', CLEARED_REFUSAL)
    act(() => commitStructuredAgentSessionOutbox('old', [inDoubt, sentThere]))
    await act(async () => {})
    expect(getStructuredAgentSessionOutbox('old')).toEqual([inDoubt, sentThere])
    expect(readNativeChatDraftCache(scope('new'))).toBe('')
    expect(view.result.current.error).toBeNull()
    // Once no tab shows it, the one in doubt is asked about afresh, and what it left follows here.
    mocks.call.mockResolvedValue({
      ok: true,
      replayed: true,
      fence: 1,
      cursor: { epoch: 'e', sequence: 1 },
      value: { clientMessageId: 'm1', submission: { clientMessageId: 'm1' } }
    })
    view.rerender({ link: 'old' })
    await waitFor(() => expect(getStructuredAgentSessionOutbox('old')).toEqual([]))
    expect(mocks.call).toHaveBeenCalledTimes(2)
    expect(readNativeChatDraftCache(scope('new'))).toBe('sent in the reopened chat')
  })
})

describe('a draft saved before the saved drafts finished loading', () => {
  afterEach(() => {
    setNativeChatComposerDraftStorageForTests(null)
    resetNativeChatComposerDraftLoadForTests()
  })

  it('is carried once the load lands, not lost to an empty read', async () => {
    const saved = createMemoryNativeChatComposerDraftStorage()
    saved.drafts.set(scope('old'), { text: 'saved before a reload', images: [], savedAt: 1 })
    let land: () => void = () => {}
    const landed = new Promise<void>((resolve) => {
      land = resolve
    })
    setNativeChatComposerDraftStorageForTests({
      ...saved,
      loadAll: async () => {
        await landed
        return new Map(saved.drafts)
      }
    })
    resetNativeChatComposerDraftLoadForTests()
    void hydrateNativeChatComposerDrafts()
    pane('new', { replaces: 'old' })
    expect(readNativeChatDraftCache(scope('new'))).toBe('')
    await act(async () => {
      land()
      await hydrateNativeChatComposerDrafts()
    })
    await waitFor(() =>
      expect(readNativeChatDraftCache(scope('new'))).toBe('saved before a reload')
    )
  })
})

describe('messages this window held for the chat a /clear replaced', () => {
  it('come back in order when proven never recorded, said once, by the right cause', async () => {
    commitStructuredAgentSessionOutbox('old', [
      refusedSend('m1', 'refused as the clear ran', CLEARED_REFUSAL),
      entry('m2', 'still waiting behind it')
    ])
    const { result } = pane('new', { replaces: 'old' })
    await waitFor(() => expect(getStructuredAgentSessionOutbox('old')).toEqual([]))
    expect(readNativeChatDraftCache(scope('new'))).toBe(
      'refused as the clear ran\n\nstill waiting behind it'
    )
    expect(result.current.error).toBe(CLEARED)
    expect(mocks.call).not.toHaveBeenCalled()
  })

  it('one refused for another reason before the clear comes back saying only it was not sent', async () => {
    // As saved: a first attempt's refusal rotates the id and leaves it never attempted.
    const refused = refusedSend('m1', 'refused for something else', {
      code: 'agent_session_owner_restart_failed',
      message: 'The agent could not restart.'
    })
    expect(refused).toMatchObject({ state: 'rejected', lastAttemptAt: null })
    commitStructuredAgentSessionOutbox('old', [refused])
    const { result } = pane('new', { replaces: 'old' })
    await waitFor(() =>
      expect(readNativeChatDraftCache(scope('new'))).toBe('refused for something else')
    )
    expect(result.current.error).toBe(NOT_SENT)
    expect(mocks.call).not.toHaveBeenCalled()
  })

  it('one whose save failed comes back saying only it was not sent', async () => {
    commitStructuredAgentSessionOutbox('old', [
      entry('m1', 'never saved to go out', { lastFailure: { kind: 'failed' } })
    ])
    const { result } = pane('new', { replaces: 'old' })
    await waitFor(() =>
      expect(readNativeChatDraftCache(scope('new'))).toBe('never saved to go out')
    )
    expect(result.current.error).toBe(NOT_SENT)
  })

  it.each([
    {
      host: 'recorded it',
      answer: {
        ok: true,
        replayed: true,
        fence: 1,
        cursor: { epoch: 'e', sequence: 1 },
        value: { clientMessageId: 'm1', submission: { clientMessageId: 'm1' } }
      },
      draft: '',
      error: null
    },
    {
      host: 'never recorded it',
      answer: {
        ok: false,
        refusal: {
          code: 'agent_session_operation_invalid',
          details: { reason: 'conversationCleared' },
          message: 'This conversation has been cleared. Use the current conversation.'
        }
      },
      draft: 'maybe ran there',
      error: CLEARED
    }
  ])(
    'one that failed after its request went out is asked under its own id: the host $host',
    async ({ answer, draft, error }) => {
      const failed = failedAfterSend('m1', 'maybe ran there')
      expect(failed).toMatchObject({
        state: 'queued',
        lastAttemptAt: 5,
        lastFailure: { kind: 'failed' }
      })
      mocks.call.mockResolvedValue(answer)
      commitStructuredAgentSessionOutbox('old', [failed])
      const { result, rerender } = pane('new', { replaces: 'old' })
      await waitFor(() => expect(getStructuredAgentSessionOutbox('old')).toEqual([]))
      expect(mocks.call).toHaveBeenCalledOnce()
      expect(mocks.call.mock.calls[0]![2]).toMatchObject({
        envelope: { sessionId: 'old', clientOperationId: 'm1' }
      })
      await waitFor(() => expect(readNativeChatDraftCache(scope('new'))).toBe(draft))
      expect(result.current.error).toBe(error)
      rerender()
      expect(readNativeChatDraftCache(scope('new'))).toBe(draft)
    }
  )

  it('a saved refusal that proves nothing (a resend refused as expired) is asked about, not handed back', async () => {
    const doubtful = refusedSend(
      'm1',
      'maybe ran there',
      { code: 'agent_session_operation_expired', message: 'Expired.' },
      2
    )
    expect(doubtful).toMatchObject({ clientMessageId: 'm1', state: 'queued', lastAttemptAt: 9 })
    mocks.call.mockResolvedValue({
      ok: true,
      replayed: true,
      fence: 1,
      cursor: { epoch: 'e', sequence: 1 },
      value: { clientMessageId: 'm1', submission: { clientMessageId: 'm1' } }
    })
    commitStructuredAgentSessionOutbox('old', [doubtful])
    const { result } = pane('new', { replaces: 'old' })
    await waitFor(() => expect(getStructuredAgentSessionOutbox('old')).toEqual([]))
    expect(mocks.call).toHaveBeenCalledOnce()
    expect(readNativeChatDraftCache(scope('new'))).toBe('')
    expect(result.current.error).toBeNull()
  })

  it('leave without their text when the host has them: its row there, its card or turn here', async () => {
    commitStructuredAgentSessionOutbox('old', [
      entry('m1', 'recorded and rejected there', {
        state: 'rejected',
        lastAttemptAt: 5,
        lastFailure: { kind: 'rejected', reason: 'The provider refused it.' }
      }),
      entry('m2', 'carried as a card', { state: 'unconfirmed', lastAttemptAt: 3 }),
      entry('m3', 'carried, and already sent here', { state: 'unconfirmed', lastAttemptAt: 4 })
    ])
    const sentHere: AgentJournalSubmission = {
      clientMessageId: 'handoff-1',
      queuedMessageId: 'm3',
      fence: 1,
      payloadFingerprint: 'fingerprint',
      dispatchState: 'accepted',
      providerItemId: null,
      reason: null,
      submittedAt: 1,
      resolvedAt: 2
    }
    const { result } = pane('new', { replaces: 'old', cards: ['m2'], submissions: [sentHere] })
    await waitFor(() => expect(getStructuredAgentSessionOutbox('old')).toEqual([]))
    expect(readNativeChatDraftCache(scope('new'))).toBe('')
    expect(result.current.error).toBeNull()
    expect(mocks.call).not.toHaveBeenCalled()
  })

  it('one whose answer was lost and DID run is asked again, and leaves without its text', async () => {
    let answer: (value: unknown) => void = () => {}
    mocks.call.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = resolve
        })
    )
    commitStructuredAgentSessionOutbox('old', [
      entry('m1', 'it ran in the old chat', { state: 'unconfirmed', lastAttemptAt: 3 })
    ])
    const { result } = pane('new', { replaces: 'old' })
    // Asked under its own id, in the chat it was sent to; meanwhile it is a sending row here.
    await waitFor(() => expect(mocks.call).toHaveBeenCalledOnce())
    expect(mocks.call.mock.calls[0]![2]).toMatchObject({
      envelope: { sessionId: 'old', clientOperationId: 'm1' }
    })
    expect(result.current.askedRows).toMatchObject([
      { clientMessageId: 'm1', state: 'dispatching' }
    ])
    // Only drawn: Stop here can't end it, so this chat's own outbox stays empty.
    expect(result.current.outbox).toEqual([])
    act(() =>
      answer({
        ok: true,
        replayed: true,
        fence: 1,
        cursor: { epoch: 'e', sequence: 1 },
        value: { clientMessageId: 'm1', submission: { clientMessageId: 'm1' } }
      })
    )
    await waitFor(() => expect(getStructuredAgentSessionOutbox('old')).toEqual([]))
    expect(readNativeChatDraftCache(scope('new'))).toBe('')
    expect(result.current.error).toBeNull()
    expect(result.current.askedRows).toEqual([])
  })

  it('one whose answer was lost and did NOT run is asked again, and comes back once', async () => {
    mocks.call.mockResolvedValue({
      ok: false,
      refusal: {
        code: 'agent_session_operation_invalid',
        details: { reason: 'conversationCleared' },
        message: 'This conversation has been cleared. Use the current conversation.'
      }
    })
    commitStructuredAgentSessionOutbox('old', [
      entry('m1', 'it never landed', { state: 'unconfirmed', lastAttemptAt: 3 })
    ])
    const { result, rerender } = pane('new', { replaces: 'old' })
    await waitFor(() => expect(readNativeChatDraftCache(scope('new'))).toBe('it never landed'))
    expect(result.current.error).toBe(CLEARED)
    rerender()
    expect(mocks.call).toHaveBeenCalledOnce()
    expect(readNativeChatDraftCache(scope('new'))).toBe('it never landed')
  })

  it('from a host whose answers are not proof, a "cleared" refusal is asked again, then comes back unconfirmed', async () => {
    // An older host may refuse as cleared a message it already ran.
    setLocalRuntimeCapabilitiesForTests([])
    mocks.call.mockResolvedValue({ ok: false, refusal: CLEARED_REFUSAL })
    commitStructuredAgentSessionOutbox('old', [
      entry('m1', 'maybe it ran', { state: 'unconfirmed', lastAttemptAt: 3 })
    ])
    vi.useFakeTimers()
    try {
      const { result } = pane('new', { replaces: 'old' })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(mocks.call).toHaveBeenCalledOnce()
      expect(readNativeChatDraftCache(scope('new'))).toBe('')
      expect(result.current.askedRows).toMatchObject([{ clientMessageId: 'm1' }])
      await act(async () => {
        await vi.advanceTimersByTimeAsync(31_000)
      })
      expect(mocks.call).toHaveBeenCalledTimes(6)
      expect(readNativeChatDraftCache(scope('new'))).toBe('maybe it ran')
      expect(result.current.error).toBe(UNCONFIRMED)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a refusal that lands after the move comes to the new chat, said there once', async () => {
    const replacement = pane('new', { replaces: 'old' })
    expect(replacement.result.current.error).toBeNull()
    // The old pane's send settles after it unmounted: its refusal is written to the old outbox.
    act(() => {
      commitStructuredAgentSessionOutbox('old', [
        refusedSend('m1', 'typed as the clear ran', CLEARED_REFUSAL)
      ])
    })
    await waitFor(() =>
      expect(readNativeChatDraftCache(scope('new'))).toBe('typed as the clear ran')
    )
    expect(replacement.result.current.error).toBe(CLEARED)
    expect(getStructuredAgentSessionOutbox('old')).toEqual([])
  })

  it("a refusal that lands before the move: the old chat keeps the host's own words, never these", async () => {
    commitStructuredAgentSessionOutbox('old', [
      refusedSend('m1', 'typed as the clear ran', CLEARED_REFUSAL)
    ])
    // The old chat, still on screen, shows the refused message as a stale chat always has.
    const old = pane('old')
    expect(old.result.current.outbox).toHaveLength(1)
    expect(old.result.current.error).not.toBe(CLEARED)
    expect(readNativeChatDraftCache(scope('old'))).toBe('')
    old.unmount()
    const replacement = pane('new', { replaces: 'old' })
    await waitFor(() =>
      expect(readNativeChatDraftCache(scope('new'))).toBe('typed as the clear ran')
    )
    expect(replacement.result.current.error).toBe(CLEARED)
  })
})
