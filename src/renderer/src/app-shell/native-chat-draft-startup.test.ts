// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it } from 'vitest'
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
it("moves what the chat's box held into the conversation its tab moved to", () => {
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
