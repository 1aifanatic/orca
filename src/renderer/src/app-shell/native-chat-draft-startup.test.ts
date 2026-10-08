// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { startNativeChatDraftLoad } from './native-chat-draft-startup'
import { applyWebSessionTabsSnapshot } from '@/runtime/web-session-tabs-sync'
import {
  ENV,
  NOW,
  WT,
  makeSnapshot,
  resetWebSessionTabsSyncTestState
} from '@/runtime/web-session-tabs-sync-test-harness'
import {
  clearNativeChatComposerDraftsForTests,
  readNativeChatComposerDraft,
  structuredAgentSessionDraftScopeKey,
  updateNativeChatComposerDraft,
  nativeChatComposerDraftWritesSettled,
  waitForNativeChatComposerDrafts
} from '@/components/native-chat/native-chat-composer-draft-store'
import {
  createMemoryNativeChatComposerDraftStorage,
  setNativeChatComposerDraftStorageForTests
} from '@/components/native-chat/native-chat-composer-draft-storage'

const initialState = useAppStore.getState()
let stop: () => void = () => {}

beforeEach(async () => {
  resetWebSessionTabsSyncTestState()
  setNativeChatComposerDraftStorageForTests(createMemoryNativeChatComposerDraftStorage())
  stop = startNativeChatDraftLoad()
  await waitForNativeChatComposerDrafts(1_000)
})

afterEach(() => {
  stop()
  useAppStore.setState(initialState, true)
  clearNativeChatComposerDraftsForTests()
  vi.useRealTimers()
})

it('re-derives a saved draft move after the first storage load fails and a retry succeeds', async () => {
  stop()
  clearNativeChatComposerDraftsForTests()
  vi.useFakeTimers()
  const storage = createMemoryNativeChatComposerDraftStorage()
  storage.drafts.set(structuredAgentSessionDraftScopeKey('old-session'), {
    text: 'saved despite the failed load',
    images: [],
    savedAt: 1
  })
  storage.loadAll = vi
    .fn()
    .mockRejectedValueOnce(new Error('temporarily unavailable'))
    .mockImplementationOnce(async () => new Map(storage.drafts))
  setNativeChatComposerDraftStorageForTests(storage)
  useAppStore.setState({
    unifiedTabsByWorktree: {
      [WT]: [{ ...chatTab('new-session'), agentSessionReplacesSessionId: 'old-session' }]
    }
  })
  stop = startNativeChatDraftLoad()
  await waitForNativeChatComposerDrafts(1_000)
  expect(readNativeChatComposerDraft(structuredAgentSessionDraftScopeKey('new-session')).text).toBe(
    ''
  )
  await vi.advanceTimersByTimeAsync(1_000)
  await nativeChatComposerDraftWritesSettled()
  await Promise.resolve()
  expect(readNativeChatComposerDraft(structuredAgentSessionDraftScopeKey('new-session')).text).toBe(
    'saved despite the failed load'
  )
})

function chatTab(entityId: string) {
  return {
    id: 'local-pane',
    entityId,
    contentType: 'agent-session' as const,
    agentSessionAgent: 'codex' as const,
    worktreeId: WT,
    groupId: 'local-group',
    label: 'Codex Chat',
    customLabel: null,
    color: null,
    createdAt: 1,
    sortOrder: 0
  }
}

// The host moves a cleared chat's tab to its new conversation, whichever client ran the /clear.
it("moves what the chat's box held into the conversation its tab moved to", async () => {
  useAppStore.setState({
    unifiedTabsByWorktree: { [WT]: [chatTab('old-session')] },
    groupsByWorktree: {
      [WT]: [
        { id: 'local-group', worktreeId: WT, tabOrder: ['local-pane'], activeTabId: 'local-pane' }
      ]
    },
    activeGroupIdByWorktree: { [WT]: 'local-group' }
  })
  updateNativeChatComposerDraft(
    structuredAgentSessionDraftScopeKey('old-session'),
    {
      text: 'typed during the clear',
      images: [{ id: 'i1', path: '/remote/shot.png', connectionId: 'ssh-1' }]
    },
    'immediate'
  )

  useAppStore.setState((state) =>
    applyWebSessionTabsSnapshot(
      state,
      makeSnapshot(
        [
          {
            type: 'agent-session',
            id: 'agent-session:new-session',
            sessionId: 'new-session',
            replacesSessionId: 'old-session',
            agent: 'codex',
            title: 'Codex Chat',
            isActive: true
          }
        ],
        { activeTabId: 'agent-session:new-session', activeTabType: 'agent-session' }
      ),
      ENV,
      NOW,
      { contentScope: 'agent-session', preserveLocalLayout: true, terminalPtyMode: 'local' }
    )
  )

  await nativeChatComposerDraftWritesSettled()
  await Promise.resolve()

  expect(useAppStore.getState().unifiedTabsByWorktree[WT]?.[0]).toMatchObject({
    id: 'local-pane',
    entityId: 'new-session'
  })
  expect(
    readNativeChatComposerDraft(structuredAgentSessionDraftScopeKey('new-session'))
  ).toMatchObject({
    text: 'typed during the clear',
    images: [{ id: 'i1', path: '/remote/shot.png', connectionId: 'ssh-1' }]
  })
  expect(readNativeChatComposerDraft(structuredAgentSessionDraftScopeKey('old-session')).text).toBe(
    ''
  )
})

it('restores a saved source into an already switched tab when startup reads its replacement', async () => {
  stop()
  clearNativeChatComposerDraftsForTests()
  const storage = createMemoryNativeChatComposerDraftStorage()
  storage.drafts.set(structuredAgentSessionDraftScopeKey('old-session'), {
    text: 'saved before the switch',
    images: [],
    savedAt: 1
  })
  setNativeChatComposerDraftStorageForTests(storage)
  useAppStore.setState({
    unifiedTabsByWorktree: {
      [WT]: [{ ...chatTab('new-session'), agentSessionReplacesSessionId: 'old-session' }]
    }
  })
  stop = startNativeChatDraftLoad()
  await waitForNativeChatComposerDrafts(1_000)
  await nativeChatComposerDraftWritesSettled()
  await Promise.resolve()
  expect(readNativeChatComposerDraft(structuredAgentSessionDraftScopeKey('new-session')).text).toBe(
    'saved before the switch'
  )
  expect(readNativeChatComposerDraft(structuredAgentSessionDraftScopeKey('old-session')).text).toBe(
    ''
  )
})
