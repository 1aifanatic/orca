// @vitest-environment happy-dom

// A message handed back to its draft leaves the outbox only once storage has saved that draft, so
// a crash in between never loses its text, and a returning message is never sent again (its id
// proved no record, so a resend would be a new first send).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StructuredAgentSessionOutboxEntry } from '../../../../shared/structured-agent-session-outbox'
import {
  createMemoryNativeChatComposerDraftStorage,
  type NativeChatComposerDraftStorage
} from './native-chat-composer-draft-storage'

const mocks = vi.hoisted(() => ({ call: vi.fn() }))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call
}))

const SESSION = 'session-1'
const SCOPE = 'agent-session:session-1'

let storage: ReturnType<typeof createMemoryNativeChatComposerDraftStorage>

/** A fresh renderer: module memory is gone; the drafts' storage and the saved outboxes are not. */
async function reload(using: NativeChatComposerDraftStorage = storage) {
  vi.resetModules()
  const storageModule = await import('./native-chat-composer-draft-storage')
  storageModule.setNativeChatComposerDraftStorageForTests(using)
  const modules = {
    returning: await import('./structured-agent-session-outbox-returning'),
    outbox: await import('./structured-agent-session-outbox-storage'),
    drafts: await import('./native-chat-draft-cache'),
    store: await import('./native-chat-composer-draft-store'),
    endings: await import('./structured-agent-session-entry-endings'),
    admission: await import('../../../../shared/structured-agent-session-outbox-admission')
  }
  await modules.store.hydrateNativeChatComposerDrafts()
  return modules
}

type Modules = Awaited<ReturnType<typeof reload>>

/** A storage that never confirms a write, as one interrupted by a crash. */
function neverCommitting(): NativeChatComposerDraftStorage {
  return {
    ...storage,
    write: () => new Promise(() => {}),
    update: () => new Promise(() => {})
  }
}

function message(patch: Partial<StructuredAgentSessionOutboxEntry> = {}) {
  return {
    clientMessageId: 'withdrawn-1',
    sessionId: SESSION,
    body: {
      kind: 'message' as const,
      role: 'user' as const,
      blocks: [{ type: 'text' as const, text: 'withdrawn message' }]
    },
    previewUris: [],
    state: 'queued' as const,
    queuedAt: 1,
    lastAttemptAt: null,
    carriedNoteKeys: ['note-a'],
    ...patch
  }
}

/** Stop's local step, as the open chat runs it, withdrawing `entry`. */
function withdraw(modules: Modules, entry: StructuredAgentSessionOutboxEntry): void {
  modules.outbox.writeOutbox(SESSION, [entry])
  modules.returning.commitStructuredAgentSessionWithdrawals(SESSION, [entry], {
    entries: [],
    withdrawn: [entry]
  })
}

async function settled(modules: Modules): Promise<void> {
  await modules.store.nativeChatComposerDraftWritesSettled()
  await Promise.resolve()
}

function endingsOf(modules: Modules): string[] {
  const endings: string[] = []
  modules.endings.subscribeToStructuredAgentSessionEntryEndings((entry, ending) => {
    if (entry.clientMessageId === 'withdrawn-1') {
      endings.push(ending)
    }
  })
  return endings
}

beforeEach(() => {
  localStorage.clear()
  mocks.call.mockReset()
  storage = createMemoryNativeChatComposerDraftStorage()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('a message handed back to its draft', () => {
  it('stays returning until storage saves the draft, then leaves and ends', async () => {
    const modules = await reload()
    const endings = endingsOf(modules)
    withdraw(modules, message())

    expect(modules.outbox.readOutbox(SESSION)).toMatchObject([
      { clientMessageId: 'withdrawn-1', returning: { ending: 'returned' } }
    ])
    expect(endings).toEqual([])
    await settled(modules)
    expect(modules.outbox.readOutbox(SESSION)).toEqual([])
    expect(endings).toEqual(['returned'])
    expect(storage.drafts.get(SCOPE)).toMatchObject({ text: 'withdrawn message' })
  })

  it('survives a crash before the draft is saved: after a reload the text is in the draft once', async () => {
    const crashed = await reload(neverCommitting())
    withdraw(crashed, message())
    await Promise.resolve()
    // The draft never reached storage, and the outbox still holds the text.
    expect(storage.drafts.get(SCOPE)).toBeUndefined()
    expect(crashed.outbox.readOutbox(SESSION)).toMatchObject([
      { returning: { ending: 'returned' } }
    ])

    const next = await reload()
    const endings = endingsOf(next)
    next.returning.resumeReturningStructuredAgentSessionEntries()
    await settled(next)
    expect(next.drafts.readNativeChatDraftCache(SCOPE)).toBe('withdrawn message')
    expect(storage.drafts.get(SCOPE)).toMatchObject({ text: 'withdrawn message' })
    expect(next.outbox.readOutbox(SESSION)).toEqual([])
    expect(endings).toEqual(['returned'])
  })

  it('survives a crash after the draft was saved but before it left: the text is not added twice', async () => {
    storage.drafts.set(SCOPE, { text: 'typed\n\nwithdrawn message', images: [], savedAt: 1 })
    localStorage.setItem(
      `orca:desktopStructuredAgentSessionOutbox:v1:${SESSION}`,
      JSON.stringify([message({ returning: { ending: 'returned' } })])
    )

    const next = await reload()
    next.returning.resumeReturningStructuredAgentSessionEntries()
    await settled(next)
    expect(next.drafts.readNativeChatDraftCache(SCOPE)).toBe('typed\n\nwithdrawn message')
    expect(next.outbox.readOutbox(SESSION)).toEqual([])
  })

  it('is never sent again and holds nothing up while it returns', async () => {
    const modules = await reload(neverCommitting())
    withdraw(modules, message({ state: 'unconfirmed', lastAttemptAt: 2 }))
    const later = message({ clientMessageId: 'later', carriedNoteKeys: undefined })
    const current = modules.outbox.readOutbox(SESSION, { recoverDispatching: false })
    expect(modules.admission.admitStructuredAgentSessionOutboxEntry(current)).toEqual({
      state: 'idle',
      entry: null
    })
    expect(
      modules.admission.admitStructuredAgentSessionOutboxEntry([...current, later])
    ).toMatchObject({ state: 'dispatch', entry: { clientMessageId: 'later' } })
  })

  it('is never resent by an open chat, by its drain or its probe, after a reload', async () => {
    localStorage.setItem(
      `orca:desktopStructuredAgentSessionOutbox:v1:${SESSION}`,
      JSON.stringify([
        message({ state: 'dispatching', lastAttemptAt: 2, returning: { ending: 'returned' } })
      ])
    )
    const modules = await reload(neverCommitting())
    const { renderHook, act, cleanup } = await import('@testing-library/react')
    const { useStructuredAgentSessionOutbox } =
      await import('./use-structured-agent-session-outbox')
    const target = { kind: 'local' as const }
    const view = renderHook(() =>
      useStructuredAgentSessionOutbox({ sessionId: SESSION, target, fence: 1, submissions: [] })
    )
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)))
    expect(mocks.call).not.toHaveBeenCalled()
    // Kept until its draft is saved, which this storage never confirms.
    expect(view.result.current.outbox).toMatchObject([{ returning: { ending: 'returned' } }])
    expect(modules.outbox.readOutbox(SESSION)).toHaveLength(1)
    cleanup()
  })

  it('stays returning while storage refuses the draft, and leaves once a later load saves it', async () => {
    storage.refuseWrites = true
    const refused = await reload()
    const endings = endingsOf(refused)
    withdraw(refused, message())
    await settled(refused)
    // The text is shown, not saved: the outbox keeps it, and nothing ended.
    expect(refused.store.isNativeChatComposerDraftUnsaved(SCOPE)).toBe(true)
    expect(refused.outbox.readOutbox(SESSION)).toMatchObject([
      { returning: { ending: 'returned' } }
    ])
    expect(endings).toEqual([])

    storage.refuseWrites = false
    const next = await reload()
    next.returning.resumeReturningStructuredAgentSessionEntries()
    await settled(next)
    expect(next.drafts.readNativeChatDraftCache(SCOPE)).toBe('withdrawn message')
    expect(next.outbox.readOutbox(SESSION)).toEqual([])
  })

  // A later save of that draft confirms the user has the text (sent or edited), so the copy goes in
  // this run: the next start never brings back what the user already sent or changed.
  it('leaves in this run once a later save of the draft lands: the user sent the returned text', async () => {
    storage.refuseWrites = true
    const run = await reload()
    withdraw(run, message())
    await settled(run)
    storage.refuseWrites = false
    // The user sends it: the composer clears the draft, saved at once.
    run.store.clearNativeChatComposerDraftIfUnchanged(
      SCOPE,
      run.store.readNativeChatComposerDraft(SCOPE)
    )
    await vi.waitFor(() => expect(run.outbox.readOutbox(SESSION)).toEqual([]))

    const next = await reload()
    next.returning.resumeReturningStructuredAgentSessionEntries()
    await settled(next)
    expect(next.drafts.readNativeChatDraftCache(SCOPE)).toBe('')
  })

  it('leaves in this run once a later save lands: the user edited the returned text', async () => {
    storage.refuseWrites = true
    const run = await reload()
    withdraw(run, message())
    await settled(run)
    storage.refuseWrites = false
    run.store.updateNativeChatComposerDraft(
      SCOPE,
      { text: 'withdrawn message, edited' },
      'immediate'
    )
    await vi.waitFor(() => expect(run.outbox.readOutbox(SESSION)).toEqual([]))

    const next = await reload()
    next.returning.resumeReturningStructuredAgentSessionEntries()
    await settled(next)
    expect(next.drafts.readNativeChatDraftCache(SCOPE)).toBe('withdrawn message, edited')
  })
})
