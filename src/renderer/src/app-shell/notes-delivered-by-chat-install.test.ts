import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DiffComment } from '../../../shared/diff-comment-types'
import type { StructuredAgentSessionOutboxEntry } from '../../../shared/structured-agent-session-outbox'

const mocks = vi.hoisted(() => ({ clearDelivered: vi.fn() }))

const note: DiffComment = {
  id: 'note-a',
  worktreeId: 'wt-1',
  filePath: 'README.md',
  lineNumber: 3,
  body: 'tighten this',
  createdAt: 1,
  side: 'modified'
}

vi.mock('../store', () => ({
  useAppStore: Object.assign(() => false, {
    getState: () => ({
      getDiffComments: () => [note],
      clearDeliveredDiffComments: mocks.clearDelivered,
      browserAnnotationsByPageId: {},
      removeDeliveredBrowserPageAnnotations: vi.fn()
    })
  })
}))
vi.mock('../components/AgentHibernationGate', () => ({ AgentHibernationGate: () => null }))
vi.mock('../components/AiVaultTabTitleSyncGate', () => ({ AiVaultTabTitleSyncGate: () => null }))
vi.mock('../components/dashboard/RetainedAgentsSyncGate', () => ({ default: () => null }))
vi.mock('../components/ports/WorkspacePortScanner', () => ({ WorkspacePortScanner: () => null }))
vi.mock('../hooks/MacosTccPromptNoticeHost', () => ({ MacosTccPromptNoticeHost: () => null }))
vi.mock('../components/native-chat/StructuredAgentSessionAttentionBridge', () => ({
  StructuredAgentSessionAttentionBridge: () => null
}))
vi.mock('../components/native-chat/StructuredAgentSessionStatusBridge', () => ({
  StructuredAgentSessionStatusBridge: () => null
}))

const RENDERER = join(__dirname, '..')

function carrying(keys: string[]): StructuredAgentSessionOutboxEntry {
  return {
    clientMessageId: 'message-1',
    sessionId: 'chat-1',
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'review notes' }] },
    previewUris: [],
    state: 'rejected',
    queuedAt: 1,
    lastAttemptAt: null,
    retryAfterUnknownSubmittedAt: null,
    source: 'launch',
    carriedNoteKeys: keys
  }
}

describe('clearing notes a chat sends on', () => {
  beforeEach(() => {
    vi.resetModules()
    mocks.clearDelivered.mockReset()
  })

  // The desktop and the web client both render App, which loads its background services.
  it('is installed by the background services both app entries render', async () => {
    expect(readFileSync(join(RENDERER, 'main.tsx'), 'utf8')).toContain("import App from './App'")
    expect(readFileSync(join(RENDERER, 'web/main.tsx'), 'utf8')).toContain("import('../App')")
    expect(readFileSync(join(RENDERER, 'App.tsx'), 'utf8')).toContain(
      "from './app-shell/AppBackgroundServices'"
    )

    await import('./AppBackgroundServices')
    const carried =
      await import('../components/native-chat/structured-agent-session-outbox-carried-notes')
    const { diffCommentSendKey } = await import('../lib/notes-send-in-flight')
    carried.recordStructuredAgentSessionCarriedNotes(
      'chat-1',
      [carrying([diffCommentSendKey(note)])],
      [],
      'spent'
    )

    expect(mocks.clearDelivered).toHaveBeenCalledWith('wt-1', [note])
  })

  it('runs once per renderer however often it is installed', async () => {
    const { installNotesDeliveredByChat } = await import('../lib/notes-delivered-by-chat')
    const carried =
      await import('../components/native-chat/structured-agent-session-outbox-carried-notes')
    const { diffCommentSendKey } = await import('../lib/notes-send-in-flight')
    installNotesDeliveredByChat()
    installNotesDeliveredByChat()

    carried.recordStructuredAgentSessionCarriedNotes(
      'chat-1',
      [carrying([diffCommentSendKey(note)])],
      [],
      'spent'
    )

    expect(mocks.clearDelivered).toHaveBeenCalledOnce()
  })
})
