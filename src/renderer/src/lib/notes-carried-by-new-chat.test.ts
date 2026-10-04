// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-session-contracts'
import type { DiffComment } from '../../../shared/diff-comment-types'
import type { BrowserPageAnnotation } from '../../../shared/browser-grab-types'
import type { StructuredAgentSessionLaunchIntent } from '@/lib/launch-structured-agent-session'

type ShelfAnnotation = Pick<BrowserPageAnnotation, 'browserPageId' | 'id' | 'comment' | 'intent'>

const mocks = vi.hoisted(() => {
  const shelf: { notes: DiffComment[]; annotations: ShelfAnnotation[] } = {
    notes: [],
    annotations: []
  }
  return {
    callStructuredAgentSession: vi.fn(),
    createIntent: vi.fn(),
    launch: vi.fn(),
    refresh: vi.fn(),
    clearDeliveredDiffComments: vi.fn(),
    removeDeliveredBrowserPageAnnotations: vi.fn(),
    shelf
  }
})

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
  refreshLocalStructuredSessionTabs: mocks.refresh
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
      getDiffComments: () => mocks.shelf.notes,
      clearDeliveredDiffComments: mocks.clearDeliveredDiffComments,
      browserAnnotationsByPageId: { 'page-1': mocks.shelf.annotations },
      removeDeliveredBrowserPageAnnotations: mocks.removeDeliveredBrowserPageAnnotations
    }),
    subscribe: () => () => undefined
  }
}))

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

vi.mock('@/lib/agent-catalog', () => ({
  getAgentLabel: () => 'Codex',
  getAgentCatalog: () => [{ id: 'codex', label: 'Codex' }]
}))

const WORKTREE_ID = 'wt-notes-new-agent'
const NOTES = 'review notes'

const note: DiffComment = {
  id: 'note-a',
  worktreeId: WORKTREE_ID,
  filePath: 'README.md',
  lineNumber: 3,
  body: 'tighten this',
  createdAt: 1,
  side: 'modified'
}

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

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    await Promise.resolve()
  }
}

const chat = launchIntent('session-notes')

/** A renderer as it starts: fresh modules over the same saved storage, the clearer installed. */
async function renderer() {
  const launch = await import('./structured-agent-session-launch')
  const outbox = await import('@/components/native-chat/structured-agent-session-outbox-storage')
  const inFlight = await import('./notes-send-in-flight')
  const { installNotesDeliveredByChat } = await import('./notes-delivered-by-chat')
  installNotesDeliveredByChat()
  return { launch, outbox, inFlight, key: inFlight.diffCommentSendKey(note) }
}

/** What "Send notes > New agent" does: the launch, carrying the notes' keys, held on its result. */
async function sendNotesToNewAgent() {
  const app = await renderer()
  const handOff = app.inFlight.notesSendHandOff([app.key])
  const started = app.launch.startStructuredAgentLaunch(WORKTREE_ID, 'codex', {
    prompt: NOTES,
    promptDelivery: 'submit-after-ready',
    carriedNoteKeys: handOff.carriedNoteKeys
  })
  handOff.handOff(started.promptDeliveryResult!)
  return app
}

/** The chat's own send accepting its staged message, as the composer's drain or a Retry does. */
function acceptStagedMessage(app: Awaited<ReturnType<typeof renderer>>): void {
  const [message] = app.outbox.readOutbox(chat.sessionId)
  app.outbox.mutateStructuredAgentSessionLaunchPrompt(
    chat.sessionId,
    message.clientMessageId,
    () => null
  )
}

describe('notes sent to a new agent', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    localStorage.clear()
    mocks.shelf.notes = [note]
    mocks.shelf.annotations = []
    mocks.createIntent.mockReturnValue(chat)
    mocks.refresh.mockResolvedValue([published(chat.sessionId)])
    mocks.callStructuredAgentSession.mockResolvedValue({
      ok: true,
      value: { submission: { dispatchState: 'accepted' } }
    })
  })

  it('save their keys with the staged message and leave the shelf once it is sent', async () => {
    mocks.launch.mockResolvedValue({ sessionId: chat.sessionId, fence: 1 })
    const app = await sendNotesToNewAgent()
    expect(app.outbox.readOutbox(chat.sessionId)[0].carriedNoteKeys).toEqual([app.key])
    expect(app.inFlight.isNoteInFlight(app.key)).toBe(true)

    await settle()

    expect(mocks.clearDeliveredDiffComments).toHaveBeenCalledWith(WORKTREE_ID, [note])
    expect(app.inFlight.isNoteInFlight(app.key)).toBe(false)
  })

  it('stay held across a reload while the chat can still send them, and clear when it does', async () => {
    mocks.launch.mockImplementation(() => new Promise(() => undefined))
    await sendNotesToNewAgent()

    vi.resetModules()
    const reloaded = await renderer()

    expect(reloaded.inFlight.isNoteInFlight(reloaded.key)).toBe(true)
    acceptStagedMessage(reloaded)
    expect(mocks.clearDeliveredDiffComments).toHaveBeenCalledWith(WORKTREE_ID, [note])
    expect(reloaded.inFlight.isNoteInFlight(reloaded.key)).toBe(false)
  })

  it('come back to the shelf when the chat is closed after a reload', async () => {
    mocks.launch.mockImplementation(() => new Promise(() => undefined))
    await sendNotesToNewAgent()

    vi.resetModules()
    const reloaded = await renderer()
    expect(reloaded.inFlight.isNoteInFlight(reloaded.key)).toBe(true)
    // Closing a chat throws its outbox away (tab retirement, cancel, workspace teardown).
    reloaded.outbox.discardStructuredAgentSessionLaunchOutbox(chat.sessionId)

    expect(reloaded.inFlight.isNoteInFlight(reloaded.key)).toBe(false)
    expect(mocks.clearDeliveredDiffComments).not.toHaveBeenCalled()
  })

  it('stay held by a failed chat, clear when its Retry sends them, and return when it closes', async () => {
    const { StructuredAgentSessionCreateRefusalError } =
      await import('@/lib/launch-structured-agent-session')
    mocks.launch.mockRejectedValueOnce(new StructuredAgentSessionCreateRefusalError('unsupported'))
    const app = await sendNotesToNewAgent()
    await settle()
    expect(app.launch.getStructuredAgentSessionLaunchLifecycle(WORKTREE_ID, chat.sessionId)).toBe(
      'failed'
    )
    expect(app.inFlight.isNoteInFlight(app.key)).toBe(true)

    mocks.launch.mockResolvedValue({ sessionId: chat.sessionId, fence: 1 })
    expect(app.launch.retryStructuredAgentSessionLaunch(WORKTREE_ID, chat.sessionId)).toBe(true)
    await settle()
    acceptStagedMessage(app)

    expect(mocks.clearDeliveredDiffComments).toHaveBeenCalledWith(WORKTREE_ID, [note])
    expect(app.inFlight.isNoteInFlight(app.key)).toBe(false)
  })

  it('return when a failed chat is closed', async () => {
    const { StructuredAgentSessionCreateRefusalError } =
      await import('@/lib/launch-structured-agent-session')
    mocks.launch.mockRejectedValue(new StructuredAgentSessionCreateRefusalError('unsupported'))
    const app = await sendNotesToNewAgent()
    await settle()

    app.launch.cancelStructuredAgentLaunch(WORKTREE_ID, chat.sessionId)

    expect(app.inFlight.isNoteInFlight(app.key)).toBe(false)
    expect(mocks.clearDeliveredDiffComments).not.toHaveBeenCalled()
  })

  it('clears browser annotations a new chat sends on', async () => {
    mocks.launch.mockImplementation(() => new Promise(() => undefined))
    mocks.shelf.annotations = [
      { id: 'annotation-1', browserPageId: 'page-1', comment: 'Fix', intent: 'fix' }
    ]
    const app = await renderer()
    const key = app.inFlight.browserAnnotationSendKey(mocks.shelf.annotations[0])
    app.launch.startStructuredAgentLaunch(WORKTREE_ID, 'codex', {
      prompt: NOTES,
      carriedNoteKeys: [key]
    })

    acceptStagedMessage(app)

    expect(mocks.removeDeliveredBrowserPageAnnotations).toHaveBeenCalledWith('page-1', [
      mocks.shelf.annotations[0]
    ])
  })
})
