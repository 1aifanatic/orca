// @vitest-environment happy-dom

// Closing a chat's tab never throws away a message the person sent, even with the host out of
// reach: one that went out stays in the outbox and is sent again when the chat is reopened; one
// that never went out comes back to the conversation's draft; only a cancelled launch's own prompt
// goes with the launch, its notes back on the shelf.

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createStructuredAgentSessionOutboxEntry } from '../../../../../shared/structured-agent-session-outbox'
import { createStructuredAgentSessionOperationId } from '../../../../../shared/structured-agent-session-mutation'

const rpc = vi.hoisted(() => ({
  call: vi.fn(async () => {
    throw new Error('host unreachable')
  }),
  session: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => {
    throw new Error('host unreachable')
  })
}))

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))
vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) => ({
  ...(await importOriginal<typeof RuntimeRpcClient>()),
  callRuntimeRpc: rpc.call
}))
vi.mock('@/runtime/structured-agent-session-client', async (importOriginal) => ({
  ...(await importOriginal<typeof StructuredAgentSessionClient>()),
  callStructuredAgentSession: rpc.session
}))

import {
  createTestStore,
  makeTabGroup,
  makeUnifiedTab,
  makeWorktree,
  seedStore
} from '../store-test-helpers'
import type * as RuntimeRpcClient from '@/runtime/runtime-rpc-client'
import type * as StructuredAgentSessionClient from '@/runtime/structured-agent-session-client'
import { createBrowserUuid } from '@/lib/browser-uuid'
import {
  nativeChatComposerDraftWritesSettled,
  readNativeChatComposerDraft,
  structuredAgentSessionDraftScopeKey
} from '@/components/native-chat/native-chat-composer-draft-store'
import { clearNativeChatDraftCacheForTests } from '@/components/native-chat/native-chat-draft-cache'
import {
  getStructuredAgentSessionOutbox,
  readOutbox,
  writeOutbox
} from '@/components/native-chat/structured-agent-session-outbox-storage'
import { resetStructuredAgentSessionCarriedNotesForTests } from '@/components/native-chat/structured-agent-session-outbox-carried-notes'
import { useStructuredAgentSessionOutbox } from '@/components/native-chat/use-structured-agent-session-outbox'
import { markStructuredAgentSessionLaunchCancelled } from '@/lib/structured-agent-session-launch-registry'
import { isNoteInFlight } from '@/lib/notes-send-in-flight'
import { subscribeToStructuredAgentSessionEntryEndings } from '@/components/native-chat/structured-agent-session-entry-endings'

const WT = 'repo1::/path/wt1'
const SID = 'session-close-1'

function seed() {
  const store = createTestStore()
  const chat = makeUnifiedTab({
    id: `agent-session:${SID}`,
    entityId: SID,
    contentType: 'agent-session',
    worktreeId: WT,
    groupId: 'g1',
    executionHostId: 'local'
  })
  seedStore(store, {
    worktreesByRepo: { repo1: [makeWorktree({ id: WT, repoId: 'repo1', path: '/path/wt1' })] },
    unifiedTabsByWorktree: { [WT]: [chat] },
    groupsByWorktree: {
      [WT]: [makeTabGroup({ id: 'g1', worktreeId: WT, activeTabId: chat.id, tabOrder: [chat.id] })]
    }
  })
  return { store, chat }
}

function entry(
  text: string,
  patch: Partial<ReturnType<typeof createStructuredAgentSessionOutboxEntry>>
) {
  return {
    ...createStructuredAgentSessionOutboxEntry({
      clientMessageId: createStructuredAgentSessionOperationId(createBrowserUuid),
      sessionId: SID,
      text,
      attachments: [],
      queuedAt: 1000
    }),
    ...patch
  }
}

function draft(): string {
  return readNativeChatComposerDraft(structuredAgentSessionDraftScopeKey(SID)).text
}

function accepted(params: unknown) {
  const id =
    typeof params === 'object' &&
    params !== null &&
    'envelope' in params &&
    typeof params.envelope === 'object' &&
    params.envelope !== null &&
    'clientOperationId' in params.envelope &&
    typeof params.envelope.clientOperationId === 'string'
      ? params.envelope.clientOperationId
      : ''
  return {
    ok: true,
    replayed: true,
    fence: 1,
    cursor: { epoch: 'e', sequence: 2 },
    value: {
      clientMessageId: id,
      submission: {
        clientMessageId: id,
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

beforeEach(() => {
  localStorage.clear()
  clearNativeChatDraftCacheForTests()
  resetStructuredAgentSessionCarriedNotesForTests()
  rpc.session.mockReset()
  rpc.session.mockRejectedValue(new Error('host unreachable'))
  Object.assign(window, { api: { pty: { kill: vi.fn() }, runtimeEnvironments: { call: vi.fn() } } })
})

afterEach(cleanup)

/** Lets each hand-back finish: its draft saved, it leaves the outbox and ends. */
async function handBacksSettled(): Promise<void> {
  await act(async () => {
    await nativeChatComposerDraftWritesSettled()
    await Promise.resolve()
  })
}

describe('closing a chat tab while the host is out of reach', () => {
  it('keeps a message that went out, and sends it again once the chat is reopened', async () => {
    const { store, chat } = seed()
    const sent = entry('UNCONFIRMED-TEXT', { state: 'unconfirmed', lastAttemptAt: 2000 })
    writeOutbox(SID, [sent])

    store.getState().closeUnifiedTab(chat.id)
    expect(readOutbox(SID, { recoverDispatching: false })).toMatchObject([
      { clientMessageId: sent.clientMessageId, state: 'unconfirmed' }
    ])
    expect(draft()).toBe('')

    // Reopened, with the host back: the same id goes again and the host has it.
    rpc.session.mockImplementation(async (_target, _method, params) => accepted(params))
    renderHook(() =>
      useStructuredAgentSessionOutbox({
        sessionId: SID,
        target: { kind: 'local' },
        fence: 1,
        submissions: [],
        journalCursor: { epoch: 'e', sequence: 1 }
      })
    )
    await vi.waitFor(() => expect(getStructuredAgentSessionOutbox(SID)).toEqual([]), {
      timeout: 3000
    })
    const sends = rpc.session.mock.calls.filter((call) => call[1] === 'agentSession.send')
    expect(sends.length).toBeGreaterThan(0)
    expect(sends.every((call) => JSON.stringify(call[2]).includes(sent.clientMessageId))).toBe(true)
  })

  it("hands a message that never went out back to the conversation's draft", async () => {
    const { store, chat } = seed()
    writeOutbox(SID, [entry('QUEUED-TEXT', { state: 'queued' })])

    store.getState().closeUnifiedTab(chat.id)
    await handBacksSettled()
    expect(readOutbox(SID)).toEqual([])
    expect(draft()).toBe('QUEUED-TEXT')
  })

  it("discards a cancelled launch's own prompt, putting its notes back", async () => {
    const { store, chat } = seed()
    markStructuredAgentSessionLaunchCancelled(WT, SID, 'local')
    writeOutbox(SID, [entry('LAUNCH-TEXT', { source: 'launch', carriedNoteKeys: ['note-a'] })])
    expect(isNoteInFlight('note-a')).toBe(true)

    store.getState().closeUnifiedTab(chat.id)
    await handBacksSettled()
    expect(readOutbox(SID)).toEqual([])
    expect(draft()).toBe('')
    expect(isNoteInFlight('note-a')).toBe(false)
  })

  // No chat shows a cancelled launch's draft, so a message typed into it gives its notes back.
  it("ends a cancelled launch's other unsent messages as discarded, so their notes come back", async () => {
    const { store, chat } = seed()
    markStructuredAgentSessionLaunchCancelled(WT, SID, 'local')
    const typed = entry('TYPED-TEXT', { carriedNoteKeys: ['note-b'] })
    writeOutbox(SID, [typed])
    const endings: string[] = []
    const unsubscribe = subscribeToStructuredAgentSessionEntryEndings((ended, ending) => {
      if (ended.clientMessageId === typed.clientMessageId) {
        endings.push(ending)
      }
    })

    store.getState().closeUnifiedTab(chat.id)
    await handBacksSettled()
    unsubscribe()
    expect(endings).toEqual(['discarded'])
    expect(readOutbox(SID)).toEqual([])
    expect(isNoteInFlight('note-b')).toBe(false)
  })
})
