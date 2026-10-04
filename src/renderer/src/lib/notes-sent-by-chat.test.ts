// A used message's notes are cleared from their shelf, waiting only while their workspace has not
// loaded yet; nothing waits on a note that can no longer appear, and nothing keeps watching the
// store once nothing is waiting.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  diffComments: new Map<string, unknown[]>(),
  workspaceSessionReady: false,
  storeListeners: new Set<() => void>(),
  getDiffCommentsCalls: 0,
  clearDeliveredDiffComments: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      workspaceSessionReady: mocks.workspaceSessionReady,
      getDiffComments: (worktreeId: string) => {
        mocks.getDiffCommentsCalls += 1
        return mocks.diffComments.get(worktreeId) ?? []
      },
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

import { endStructuredAgentSessionEntry } from '@/components/native-chat/structured-agent-session-entry-endings'
import { browserAnnotationSendKey, diffCommentSendKey } from './notes-send-in-flight'
import { installNotesSentByChat } from './notes-sent-by-chat'

const NOTE = { id: 'note-a', body: 'fix this', filePath: 'a.ts', lineNumber: 1 }
const KEY = diffCommentSendKey('wt', NOTE)

function storeWrite(): void {
  for (const listener of mocks.storeListeners) {
    listener()
  }
}

function used(keys: string[], clientMessageId = 'm'): void {
  endStructuredAgentSessionEntry(
    { sessionId: 's', clientMessageId, carriedNoteKeys: keys },
    'delivered'
  )
}

let uninstall = (): void => {}

beforeEach(() => {
  mocks.diffComments = new Map([['wt', [NOTE]]])
  mocks.workspaceSessionReady = true
  mocks.storeListeners.clear()
  mocks.getDiffCommentsCalls = 0
  mocks.clearDeliveredDiffComments.mockReset()
  mocks.clearDeliveredDiffComments.mockImplementation(
    async (worktreeId: string, notes: unknown[]) => {
      mocks.diffComments.set(
        worktreeId,
        (mocks.diffComments.get(worktreeId) ?? []).filter((note) => !notes.includes(note))
      )
      return true
    }
  )
  uninstall = installNotesSentByChat()
})

afterEach(() => uninstall())

describe('notes a used message carried', () => {
  // A pending answer, then the journal's row: the same message ends delivered twice.
  it('are cleared once, and a second ending for them adds nothing', () => {
    used([KEY])
    used([KEY])
    expect(mocks.clearDeliveredDiffComments).toHaveBeenCalledExactlyOnceWith('wt', [NOTE])
    expect(mocks.storeListeners.size).toBe(0)
  })

  it('wait for a workspace that has not loaded, and are cleared once it does', () => {
    mocks.workspaceSessionReady = false
    mocks.diffComments = new Map()
    used([KEY])
    expect(mocks.clearDeliveredDiffComments).not.toHaveBeenCalled()
    expect(mocks.storeListeners.size).toBe(1)

    mocks.diffComments = new Map([['wt', [NOTE]]])
    storeWrite()
    expect(mocks.clearDeliveredDiffComments).toHaveBeenCalledExactlyOnceWith('wt', [NOTE])
    expect(mocks.storeListeners.size).toBe(0)
  })

  it('are dropped when their note can no longer appear, and leave nothing watching', () => {
    const edited = diffCommentSendKey('wt', { ...NOTE, body: 'what it said when sent' })
    const removedWorktree = diffCommentSendKey('removed-wt', NOTE)
    const closedPage = browserAnnotationSendKey({
      browserPageId: 'closed-page',
      id: 'a',
      comment: 'c',
      intent: 'fix'
    })
    used([edited, removedWorktree, closedPage])
    expect(mocks.clearDeliveredDiffComments).not.toHaveBeenCalled()
    expect(mocks.storeListeners.size).toBe(0)
  })

  it('stop being looked for once the session loads without them, so no write scans again', () => {
    mocks.workspaceSessionReady = false
    mocks.diffComments = new Map()
    used([diffCommentSendKey('removed-wt', NOTE)])
    expect(mocks.storeListeners.size).toBe(1)

    mocks.workspaceSessionReady = true
    storeWrite()
    expect(mocks.storeListeners.size).toBe(0)
    mocks.getDiffCommentsCalls = 0
    for (let write = 0; write < 100; write += 1) {
      storeWrite()
    }
    expect(mocks.getDiffCommentsCalls).toBe(0)
    expect(mocks.clearDeliveredDiffComments).not.toHaveBeenCalled()
  })
})
