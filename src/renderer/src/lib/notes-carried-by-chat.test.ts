// @vitest-environment happy-dom

// Notes sent to a chat stay off the shelf for as long as this client still holds the message that
// carries them, reload included, and the message's own ending decides what happens to them. Notes
// follow their text: the host has it, or its text went back to the composer → used, cleared; only
// a message thrown away with nothing handed back puts them back on the shelf. Never inferred from
// tabs or host syncs; past the host's window for the message the hold lapses.

import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-session-contracts'
import type { StructuredAgentSessionLaunchIntent } from '@/lib/launch-structured-agent-session'
import { AGENT_SESSION_SEND_ANSWERS_PROOF_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import { AGENT_SESSION_MAX_OPERATION_REPLAY_AGE_MS } from '../../../shared/agent-session-host-authority'

const mocks = vi.hoisted(() => ({
  callStructuredAgentSession: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  createIntent: vi.fn(),
  launch: vi.fn(),
  clearDeliveredDiffComments: vi.fn(async () => true),
  diffComments: Array.of<unknown>(),
  storeListeners: new Set<() => void>()
}))

vi.mock('sonner', () => ({ toast: { error: vi.fn(), message: vi.fn() } }))

vi.mock('@/lib/launch-structured-agent-session', () => {
  class StructuredAgentSessionCreateRefusalError extends Error {}
  return {
    createStructuredAgentSessionLaunchIntent: mocks.createIntent,
    retryStructuredAgentSessionLaunchIntent: (intent: unknown) => intent,
    restoreStructuredAgentSessionLaunchIntent: vi.fn(),
    abandonStructuredAgentSessionLaunchIntent: vi.fn(),
    launchStructuredAgentSession: mocks.launch,
    StructuredAgentSessionCreateRefusalError
  }
})

vi.mock('@/runtime/local-structured-session-tabs-sync', () => ({
  refreshLocalStructuredSessionTabs: vi.fn()
}))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.callStructuredAgentSession
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      unifiedTabsByWorktree: {},
      seedNativeChatLaunchDraft: vi.fn(),
      clearNativeChatLaunchDraft: vi.fn(),
      getDiffComments: () => mocks.diffComments,
      clearDeliveredDiffComments: mocks.clearDeliveredDiffComments,
      browserAnnotationsByPageId: {},
      removeDeliveredBrowserPageAnnotations: vi.fn()
    }),
    subscribe: (listener: () => void) => {
      mocks.storeListeners.add(listener)
      return () => mocks.storeListeners.delete(listener)
    }
  }
}))

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

vi.mock('@/lib/agent-catalog', () => ({
  getAgentLabel: () => 'Codex',
  getAgentCatalog: () => [{ id: 'codex', label: 'Codex' }]
}))

import { StructuredAgentSessionCreateRefusalError } from '@/lib/launch-structured-agent-session'
import { refreshLocalStructuredSessionTabs } from '@/runtime/local-structured-session-tabs-sync'
import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/local-runtime-capabilities'
import { readOutbox } from '@/components/native-chat/structured-agent-session-outbox-storage'
import { resetStructuredAgentSessionCarriedNotesForTests } from '@/components/native-chat/structured-agent-session-outbox-carried-notes'
import { useStructuredAgentSessionOutbox } from '@/components/native-chat/use-structured-agent-session-outbox'
import {
  nativeChatComposerDraftWritesSettled,
  structuredAgentSessionDraftScopeKey
} from '@/components/native-chat/native-chat-composer-draft-store'
import {
  clearNativeChatDraftCacheForTests,
  readNativeChatDraftCache
} from '@/components/native-chat/native-chat-draft-cache'
import {
  cancelStructuredAgentLaunch,
  getStructuredAgentSessionLaunchLifecycle,
  retryStructuredAgentSessionLaunch,
  startStructuredAgentLaunch
} from './structured-agent-session-launch'
import { resetStructuredAgentLaunchPersistenceForTests } from './structured-agent-session-launch-persistence'
import { resetStructuredAgentLaunchRegistryForTests } from './structured-agent-session-launch-registry'
import {
  diffCommentSendKey,
  isNoteInFlight,
  resetNotesInFlightForTests
} from './notes-send-in-flight'
import { installNotesSentByChat } from './notes-sent-by-chat'
import {
  acceptPairedHostStructuredSessions,
  suppressCancelledStructuredSessionTabs
} from '@/runtime/structured-agent-session-tab-retirement'
import { sendMessageToAgent } from './agent-message-send'

const WORKTREE_ID = 'wt-notes'
const NOTES = 'review notes'
const NOTE_A = { id: 'note-a', body: 'fix this', filePath: 'a.ts', lineNumber: 1 }
const NOTE_B = { id: 'note-b', body: 'and this', filePath: 'b.ts', lineNumber: 2 }
const KEY_A = diffCommentSendKey(WORKTREE_ID, NOTE_A)
const KEY_B = diffCommentSendKey(WORKTREE_ID, NOTE_B)

function launchIntent(sessionId: string): StructuredAgentSessionLaunchIntent {
  return {
    worktreeId: WORKTREE_ID,
    sessionId,
    executionHostId: 'local',
    target: { kind: 'local' },
    agent: 'codex',
    params: {
      envelope: {
        sessionId,
        clientOperationId: `operation-${sessionId}`,
        expectedRuntimeFence: null,
        payloadFingerprint: `fingerprint-${sessionId}`
      },
      worktree: `id:${WORKTREE_ID}`,
      agent: 'codex'
    }
  }
}

function published(sessionId: string): RuntimeMobileSessionTabsResult {
  return {
    worktree: WORKTREE_ID,
    publicationEpoch: 'epoch-1',
    snapshotVersion: 1,
    activeGroupId: null,
    activeTabId: null,
    activeTabType: null,
    tabs: [
      {
        type: 'agent-session',
        id: 'tab-1',
        title: 'Codex',
        sessionId,
        agent: 'codex',
        isActive: false
      }
    ]
  }
}

/** The operation id a request carried, read without trusting its shape. */
function sentOperationId(params: unknown): string {
  if (typeof params !== 'object' || params === null || !('envelope' in params)) {
    return ''
  }
  const { envelope } = params
  return typeof envelope === 'object' &&
    envelope !== null &&
    'clientOperationId' in envelope &&
    typeof envelope.clientOperationId === 'string'
    ? envelope.clientOperationId
    : ''
}

function accepted(params: unknown) {
  const clientMessageId = sentOperationId(params)
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

const REFUSED = { ok: false, refusal: { code: 'agent_session_journal_unreadable', message: 'x' } }

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    await Promise.resolve()
  }
}

async function waitFor(check: () => boolean, ms = 3000): Promise<void> {
  const until = Date.now() + ms
  while (!check()) {
    if (Date.now() > until) {
      throw new Error('timed out')
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

/** What a reload leaves of the notes' hold: the saved outboxes, and nothing held in memory. */
function reload(): void {
  cleanup()
  resetNotesInFlightForTests()
  resetStructuredAgentSessionCarriedNotesForTests()
}

/** The chat open on the session: its outbox sends what it holds, under the same id. With no
 *  fence it is not attached yet, so nothing goes out. */
function openChat(sessionId: string, fence: number | null = 1) {
  return renderHook(() =>
    useStructuredAgentSessionOutbox({
      sessionId,
      target: { kind: 'local' },
      fence,
      submissions: [],
      journalCursor: { epoch: 'e', sequence: 1 }
    })
  )
}

/** What the session's draft held each time notes were cleared: the text must already be there,
 *  so a crash between the two never loses both. */
function draftWhenNotesClear(sessionId: string): string[] {
  const seen: string[] = []
  mocks.clearDeliveredDiffComments.mockImplementation(async () => {
    seen.push(readNativeChatDraftCache(structuredAgentSessionDraftScopeKey(sessionId)))
    return true
  })
  return seen
}

/** A store change, as a workspace's notes loading makes. */
function notifyStore(): void {
  for (const listener of mocks.storeListeners) {
    listener()
  }
}

function sentIds(): string[] {
  return mocks.callStructuredAgentSession.mock.calls.map((call) => sentOperationId(call[2]))
}

const chat = launchIntent('session-notes')
let uninstall = (): void => {}

beforeEach(() => {
  vi.resetAllMocks()
  localStorage.clear()
  clearNativeChatDraftCacheForTests()
  resetStructuredAgentLaunchPersistenceForTests()
  resetStructuredAgentLaunchRegistryForTests()
  reload()
  mocks.storeListeners.clear()
  mocks.diffComments = [NOTE_A, NOTE_B]
  mocks.clearDeliveredDiffComments.mockResolvedValue(true)
  mocks.createIntent.mockReturnValue(chat)
  vi.mocked(refreshLocalStructuredSessionTabs).mockResolvedValue([published(chat.sessionId)])
  setLocalRuntimeCapabilitiesForTests([AGENT_SESSION_SEND_ANSWERS_PROOF_RUNTIME_CAPABILITY])
  uninstall = installNotesSentByChat()
})

afterEach(() => {
  uninstall()
  cleanup()
  vi.restoreAllMocks()
  setLocalRuntimeCapabilitiesForTests(null)
})

/** "Send notes to > New agent": the launch saves the notes' keys with its staged message. */
function sendNotesToNewAgent() {
  // One user gesture, one request id: a launch joins another only on an equal id.
  return startStructuredAgentLaunch(WORKTREE_ID, 'codex', {
    requestId: 'request-1',
    prompt: NOTES,
    promptDelivery: 'submit-after-ready',
    carriedNoteKeys: [KEY_A]
  })
}

describe('notes sent to a new agent', () => {
  it('stay held across a reload while the send is unanswered, then are delivered once', async () => {
    mocks.launch.mockResolvedValue({ sessionId: chat.sessionId, fence: 1 })
    mocks.callStructuredAgentSession.mockRejectedValueOnce(new Error('socket closed'))
    mocks.callStructuredAgentSession.mockImplementation(async (_t, _m, params) => accepted(params))
    sendNotesToNewAgent()
    await settle()
    expect(readOutbox(chat.sessionId)).toMatchObject([{ state: 'unconfirmed' }])

    reload()
    // "Send notes" again leaves the held note out and offers only the other one.
    expect(isNoteInFlight(KEY_A)).toBe(true)
    expect(isNoteInFlight(KEY_B)).toBe(false)

    openChat(chat.sessionId)
    await waitFor(() => readOutbox(chat.sessionId).length === 0)
    // One message, under one id: the first attempt and its resend.
    expect(new Set(sentIds()).size).toBe(1)
    expect(mocks.clearDeliveredDiffComments).toHaveBeenCalledExactlyOnceWith(WORKTREE_ID, [NOTE_A])
    expect(isNoteInFlight(KEY_A)).toBe(false)
  })

  it('are used once the resend is refused: the text is in the draft, so the notes are cleared', async () => {
    mocks.launch.mockResolvedValue({ sessionId: chat.sessionId, fence: 1 })
    mocks.callStructuredAgentSession.mockRejectedValueOnce(new Error('socket closed'))
    mocks.callStructuredAgentSession.mockResolvedValue(REFUSED)
    sendNotesToNewAgent()
    await settle()
    reload()
    expect(isNoteInFlight(KEY_A)).toBe(true)

    const cleared = draftWhenNotesClear(chat.sessionId)
    openChat(chat.sessionId)
    await waitFor(() => readOutbox(chat.sessionId).length === 0)
    expect(isNoteInFlight(KEY_A)).toBe(false)
    expect(readNativeChatDraftCache(structuredAgentSessionDraftScopeKey(chat.sessionId))).toBe(
      NOTES
    )
    // One owner: the draft holds the text, so the notes leave the shelf.
    expect(mocks.clearDeliveredDiffComments).toHaveBeenCalledExactlyOnceWith(WORKTREE_ID, [NOTE_A])
    expect(cleared).toEqual([NOTES])
  })

  it('stay held while a failed chat keeps them to start again, and leave once it delivers', async () => {
    mocks.launch.mockRejectedValueOnce(new StructuredAgentSessionCreateRefusalError('unsupported'))
    sendNotesToNewAgent()
    await settle()
    expect(getStructuredAgentSessionLaunchLifecycle(WORKTREE_ID, chat.sessionId)).toBe('failed')
    reload()
    expect(isNoteInFlight(KEY_A)).toBe(true)

    mocks.launch.mockResolvedValue({ sessionId: chat.sessionId, fence: 1 })
    mocks.callStructuredAgentSession.mockImplementation(async (_t, _m, params) => accepted(params))
    expect(retryStructuredAgentSessionLaunch(WORKTREE_ID, chat.sessionId)).toBe(true)
    openChat(chat.sessionId)
    await waitFor(() => readOutbox(chat.sessionId).length === 0)
    expect(mocks.clearDeliveredDiffComments).toHaveBeenCalledExactlyOnceWith(WORKTREE_ID, [NOTE_A])
    expect(isNoteInFlight(KEY_A)).toBe(false)
  })

  it('come back when a chat still starting is closed, without waiting on its create', async () => {
    mocks.launch.mockImplementation(() => new Promise(() => undefined))
    sendNotesToNewAgent()
    expect(isNoteInFlight(KEY_A)).toBe(true)

    cancelStructuredAgentLaunch(WORKTREE_ID, chat.sessionId)
    await settle()
    expect(isNoteInFlight(KEY_A)).toBe(false)
    expect(mocks.clearDeliveredDiffComments).not.toHaveBeenCalled()
  })

  it('come back when this window closes the failed chat, which hands no text back', async () => {
    mocks.launch.mockRejectedValue(new StructuredAgentSessionCreateRefusalError('unsupported'))
    sendNotesToNewAgent()
    await settle()
    expect(isNoteInFlight(KEY_A)).toBe(true)

    cancelStructuredAgentLaunch(WORKTREE_ID, chat.sessionId)
    await settle()
    expect(isNoteInFlight(KEY_A)).toBe(false)
    expect(mocks.clearDeliveredDiffComments).not.toHaveBeenCalled()
  })
})

describe('notes sent to a chat already open', () => {
  const target = { kind: 'structured-session' as const, sessionId: 'session-open' }

  it('are held by the queued message until the host has it, then cleared as sent', async () => {
    await expect(
      sendMessageToAgent({
        worktreeId: WORKTREE_ID,
        prompt: NOTES,
        target,
        carriedNoteKeys: [KEY_A]
      })
    ).resolves.toEqual({ status: 'sent', notesHeldByChat: true })
    reload()
    expect(isNoteInFlight(KEY_A)).toBe(true)
    expect(mocks.clearDeliveredDiffComments).not.toHaveBeenCalled()

    mocks.callStructuredAgentSession.mockImplementation(async (_t, _m, params) => accepted(params))
    openChat(target.sessionId)
    await waitFor(() => readOutbox(target.sessionId).length === 0)
    expect(mocks.clearDeliveredDiffComments).toHaveBeenCalledExactlyOnceWith(WORKTREE_ID, [NOTE_A])
    expect(isNoteInFlight(KEY_A)).toBe(false)
  })

  it('are used when the host turns the message away: the text is in the draft, notes cleared', async () => {
    await sendMessageToAgent({
      worktreeId: WORKTREE_ID,
      prompt: NOTES,
      target,
      carriedNoteKeys: [KEY_A]
    })
    expect(isNoteInFlight(KEY_A)).toBe(true)

    const cleared = draftWhenNotesClear(target.sessionId)
    mocks.callStructuredAgentSession.mockResolvedValue(REFUSED)
    openChat(target.sessionId)
    await waitFor(() => readOutbox(target.sessionId).length === 0)
    expect(isNoteInFlight(KEY_A)).toBe(false)
    expect(readNativeChatDraftCache(structuredAgentSessionDraftScopeKey(target.sessionId))).toBe(
      NOTES
    )
    expect(mocks.clearDeliveredDiffComments).toHaveBeenCalledExactlyOnceWith(WORKTREE_ID, [NOTE_A])
    expect(cleared).toEqual([NOTES])
  })

  it('are used when a Stop takes back the message before it went out', async () => {
    await sendMessageToAgent({
      worktreeId: WORKTREE_ID,
      prompt: NOTES,
      target,
      carriedNoteKeys: [KEY_A]
    })
    const cleared = draftWhenNotesClear(target.sessionId)
    const view = openChat(target.sessionId, null)
    view.result.current.stop('stop-1')
    await Promise.resolve()

    expect(readOutbox(target.sessionId)).toEqual([])
    expect(readNativeChatDraftCache(structuredAgentSessionDraftScopeKey(target.sessionId))).toBe(
      NOTES
    )
    // Until storage confirms the draft, a crash could lose the text: the notes stay, held.
    expect(isNoteInFlight(KEY_A)).toBe(true)
    expect(mocks.clearDeliveredDiffComments).not.toHaveBeenCalled()
    await nativeChatComposerDraftWritesSettled()
    await Promise.resolve()
    await Promise.resolve()
    expect(isNoteInFlight(KEY_A)).toBe(false)
    expect(mocks.clearDeliveredDiffComments).toHaveBeenCalledExactlyOnceWith(WORKTREE_ID, [NOTE_A])
    expect(cleared).toEqual([NOTES])
  })

  it('are cleared once their workspace loads, when the host took the message before that', async () => {
    await sendMessageToAgent({
      worktreeId: WORKTREE_ID,
      prompt: NOTES,
      target,
      carriedNoteKeys: [KEY_A]
    })
    reload()
    // The workspace's notes are not in the store yet when the message is delivered.
    mocks.diffComments = []
    mocks.callStructuredAgentSession.mockImplementation(async (_t, _m, params) => accepted(params))
    openChat(target.sessionId)
    await waitFor(() => readOutbox(target.sessionId).length === 0)
    expect(mocks.clearDeliveredDiffComments).not.toHaveBeenCalled()

    mocks.diffComments = [NOTE_A, NOTE_B]
    notifyStore()
    expect(mocks.clearDeliveredDiffComments).toHaveBeenCalledExactlyOnceWith(WORKTREE_ID, [NOTE_A])
    notifyStore()
    expect(mocks.clearDeliveredDiffComments).toHaveBeenCalledOnce()
  })

  it("lapse once the host's window for the message closes, with nothing deleted", async () => {
    await sendMessageToAgent({
      worktreeId: WORKTREE_ID,
      prompt: NOTES,
      target,
      carriedNoteKeys: [KEY_A]
    })
    reload()
    expect(isNoteInFlight(KEY_A)).toBe(true)

    const later = Date.now() + AGENT_SESSION_MAX_OPERATION_REPLAY_AGE_MS + 1_000
    vi.spyOn(Date, 'now').mockReturnValue(later)
    expect(isNoteInFlight(KEY_A)).toBe(false)
    expect(readOutbox(target.sessionId)).toHaveLength(1)
  })

  // The host-sync entry points a chat's absence passes through: a paired host's frame, and a
  // local snapshot run through the cancelled-launch filter. Neither may touch the outbox.
  it('are never released or discarded by a host frame that no longer lists the chat', async () => {
    await sendMessageToAgent({
      worktreeId: WORKTREE_ID,
      prompt: NOTES,
      target,
      carriedNoteKeys: [KEY_A]
    })
    reload()
    const empty = { ...published(target.sessionId), tabs: [] }
    acceptPairedHostStructuredSessions(empty, 'server-1')
    suppressCancelledStructuredSessionTabs(empty, { kind: 'local' })
    await settle()

    expect(isNoteInFlight(KEY_A)).toBe(true)
    expect(readOutbox(target.sessionId)).toHaveLength(1)
    expect(mocks.clearDeliveredDiffComments).not.toHaveBeenCalled()
  })
})
