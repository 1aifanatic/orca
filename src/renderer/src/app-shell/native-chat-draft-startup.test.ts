// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { startNativeChatDraftLoad } from './native-chat-draft-startup'
import {
  applyWebSessionTabsSnapshot,
  shouldApplyWebSessionTabsSnapshot
} from '@/runtime/web-session-tabs-sync'
import {
  applyLocalStructuredSessionTabSnapshots,
  resetLocalStructuredSessionVersionForTests
} from '@/runtime/local-structured-session-tabs-sync'
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
  structuredAgentSessionDraftScopeKey as scope,
  updateNativeChatComposerDraft,
  nativeChatComposerDraftWritesSettled,
  waitForNativeChatComposerDrafts
} from '@/components/native-chat/native-chat-composer-draft-store'
import {
  createMemoryNativeChatComposerDraftStorage,
  setNativeChatComposerDraftStorageForTests
} from '@/components/native-chat/native-chat-composer-draft-storage'
import {
  addNativeChatPendingAttachment,
  clearNativeChatPendingAttachmentsForTests,
  settleNativeChatPendingAttachment
} from '@/components/native-chat/native-chat-pending-attachment-cache'

const initial = useAppStore.getState()
let stop = (): void => {}
function chat(entityId: string, id = 'pane') {
  return {
    id,
    entityId,
    contentType: 'agent-session' as const,
    agentSessionAgent: 'codex' as const,
    worktreeId: WT,
    groupId: 'group',
    label: 'Chat',
    customLabel: null,
    color: null,
    createdAt: 1,
    sortOrder: 0
  }
}
function snapshot(sessionId: string, source: string, version = 1) {
  return makeSnapshot(
    [
      {
        type: 'agent-session',
        id: `agent-session:${sessionId}`,
        sessionId,
        replacesSessionId: source,
        agent: 'codex',
        title: 'Chat',
        isActive: true
      }
    ],
    { snapshotVersion: version }
  )
}
function publish(frame: ReturnType<typeof makeSnapshot>): void {
  if (shouldApplyWebSessionTabsSnapshot(frame, ENV)) {
    useAppStore.setState((state) =>
      applyWebSessionTabsSnapshot(state, frame, ENV, NOW, {
        contentScope: 'agent-session',
        preserveLocalLayout: true,
        terminalPtyMode: 'local'
      })
    )
  }
}
async function settled(): Promise<void> {
  await Promise.resolve()
  await nativeChatComposerDraftWritesSettled()
  await Promise.resolve()
}
beforeEach(async () => {
  resetWebSessionTabsSyncTestState()
  resetLocalStructuredSessionVersionForTests()
  setNativeChatComposerDraftStorageForTests(createMemoryNativeChatComposerDraftStorage())
  stop = startNativeChatDraftLoad()
  await waitForNativeChatComposerDrafts(1000)
})
afterEach(() => {
  stop()
  useAppStore.setState(initial, true)
  clearNativeChatComposerDraftsForTests()
  clearNativeChatPendingAttachmentsForTests()
  localStorage.removeItem('orca:nativeChatComposerDraftJournal:v1')
  vi.useRealTimers()
})

it('moves text and images through the real host snapshot binding change', async () => {
  useAppStore.setState({ unifiedTabsByWorktree: { [WT]: [chat('a')] } })
  updateNativeChatComposerDraft(
    scope('a'),
    {
      text: 'typed during clear',
      images: [{ id: 'i', path: '/remote/shot.png', connectionId: 'ssh-1' }]
    },
    'immediate'
  )
  publish(snapshot('b', 'a'))
  await settled()
  expect(useAppStore.getState().unifiedTabsByWorktree[WT]?.[0]).toMatchObject({
    id: 'pane',
    entityId: 'b'
  })
  expect(readNativeChatComposerDraft(scope('b'))).toMatchObject({
    text: 'typed during clear',
    images: [{ id: 'i', path: '/remote/shot.png', connectionId: 'ssh-1' }]
  })
  expect(readNativeChatComposerDraft(scope('a')).text).toBe('')
})

it('leaves a saved draft on its earlier conversation when this renderer did not observe the clear', async () => {
  stop()
  clearNativeChatComposerDraftsForTests()
  const storage = createMemoryNativeChatComposerDraftStorage()
  storage.drafts.set(scope('a'), { text: 'reachable from history', images: [], savedAt: 1 })
  setNativeChatComposerDraftStorageForTests(storage)
  useAppStore.setState({ unifiedTabsByWorktree: { [WT]: [chat('b')] } })
  stop = startNativeChatDraftLoad()
  publish(snapshot('b', 'a'))
  await waitForNativeChatComposerDrafts(1000)
  await settled()
  expect(readNativeChatComposerDraft(scope('a')).text).toBe('reachable from history')
  expect(readNativeChatComposerDraft(scope('b')).text).toBe('')
})

it('keeps a later closed-history draft through restart and repeated replacement publications', async () => {
  const storage = createMemoryNativeChatComposerDraftStorage()
  setNativeChatComposerDraftStorageForTests(storage)
  useAppStore.setState({ unifiedTabsByWorktree: { [WT]: [chat('a')] } })
  updateNativeChatComposerDraft(scope('a'), { text: 'first draft' }, 'immediate')
  publish(snapshot('b', 'a'))
  await settled()
  useAppStore.setState({ unifiedTabsByWorktree: { [WT]: [chat('b'), chat('a', 'history')] } })
  updateNativeChatComposerDraft(scope('a'), { text: 'later history draft' }, 'immediate')
  useAppStore.setState({ unifiedTabsByWorktree: { [WT]: [chat('b')] } })
  await settled()
  stop()
  clearNativeChatComposerDraftsForTests()
  setNativeChatComposerDraftStorageForTests(storage)
  resetWebSessionTabsSyncTestState()
  stop = startNativeChatDraftLoad()
  publish(snapshot('b', 'a'))
  await waitForNativeChatComposerDrafts(1000)
  publish(snapshot('b', 'a', 2))
  await settled()
  expect(readNativeChatComposerDraft(scope('a')).text).toBe('later history draft')
  expect(readNativeChatComposerDraft(scope('b')).text).toBe('first draft')
})

it.each(['local', 'paired'] as const)(
  'does not infer a move from %s unverifiable then verified inventories',
  async (host) => {
    useAppStore.setState({ unifiedTabsByWorktree: { [WT]: [chat('b')] } })
    updateNativeChatComposerDraft(scope('a'), { text: 'earlier conversation' }, 'immediate')
    const first = makeSnapshot([], { agentSessionsUnverifiable: true })
    const next = snapshot('b', 'a', 2)
    for (const frame of [first, next]) {
      if (host === 'paired') {
        publish(frame)
      } else {
        useAppStore.setState((state) =>
          applyLocalStructuredSessionTabSnapshots(state, [frame], undefined, NOW, {
            authoritative: true
          })
        )
      }
      await settled()
    }
    expect(readNativeChatComposerDraft(scope('a')).text).toBe('earlier conversation')
    expect(readNativeChatComposerDraft(scope('b')).text).toBe('')
    publish(snapshot('c', 'b', 3))
    await settled()
    expect(readNativeChatComposerDraft(scope('a')).text).toBe('earlier conversation')
  }
)

it('carries back-to-back hydrated replacements without leaving an intermediate draft', () => {
  useAppStore.setState({ unifiedTabsByWorktree: { [WT]: [chat('a')] } })
  updateNativeChatComposerDraft(scope('a'), { text: 'question' }, 'immediate')
  addNativeChatPendingAttachment(scope('a'), { id: 'upload', path: '', pending: true })
  publish(snapshot('b', 'a'))
  publish(snapshot('c', 'b', 2))
  expect(readNativeChatComposerDraft(scope('a')).text).toBe('')
  expect(readNativeChatComposerDraft(scope('b')).text).toBe('')
  expect(readNativeChatComposerDraft(scope('c')).text).toBe('question')
  settleNativeChatPendingAttachment(scope('a'), 'upload', '/ssh/image.png', 'ssh-1')
  expect(readNativeChatComposerDraft(scope('c')).images).toEqual([
    { id: 'upload', path: '/ssh/image.png', connectionId: 'ssh-1' }
  ])
})

it.each(['before', 'after'] as const)(
  'leaves input and an upload settled %s a pre-load replacement in history',
  async (settleAt) => {
    stop()
    clearNativeChatComposerDraftsForTests()
    const storage = createMemoryNativeChatComposerDraftStorage()
    storage.drafts.set(scope('a'), { text: 'saved history input', images: [], savedAt: 1 })
    let finish = (): void => {}
    storage.loadAll = () =>
      new Promise((resolve) => {
        const drafts = new Map(storage.drafts)
        finish = () => resolve(drafts)
      })
    setNativeChatComposerDraftStorageForTests(storage)
    useAppStore.setState({ unifiedTabsByWorktree: { [WT]: [chat('a')] } })
    stop = startNativeChatDraftLoad()
    addNativeChatPendingAttachment(scope('a'), { id: 'upload', path: '', pending: true })
    if (settleAt === 'before') {
      settleNativeChatPendingAttachment(scope('a'), 'upload', '/ssh/image.png', 'ssh-1')
      await settled()
    }
    publish(snapshot('b', 'a'))
    if (settleAt === 'after') {
      settleNativeChatPendingAttachment(scope('a'), 'upload', '/ssh/image.png', 'ssh-1')
    }
    finish()
    await waitForNativeChatComposerDrafts(1000)
    await settled()
    expect(readNativeChatComposerDraft(scope('a'))).toMatchObject({
      text: 'saved history input',
      images: [{ id: 'upload', path: '/ssh/image.png', connectionId: 'ssh-1' }]
    })
    expect(readNativeChatComposerDraft(scope('b'))).toMatchObject({ text: '', images: [] })
  }
)

it('does not replay a skipped clear after the existing load retry succeeds', async () => {
  stop()
  clearNativeChatComposerDraftsForTests()
  vi.useFakeTimers()
  const storage = createMemoryNativeChatComposerDraftStorage()
  storage.drafts.set(scope('a'), { text: 'history draft', images: [], savedAt: 1 })
  storage.loadAll = vi
    .fn()
    .mockRejectedValueOnce(new Error('temporary failure'))
    .mockImplementationOnce(async () => new Map(storage.drafts))
  setNativeChatComposerDraftStorageForTests(storage)
  useAppStore.setState({ unifiedTabsByWorktree: { [WT]: [chat('a')] } })
  stop = startNativeChatDraftLoad()
  publish(snapshot('b', 'a'))
  await waitForNativeChatComposerDrafts(1000)
  await vi.advanceTimersByTimeAsync(1000)
  await settled()
  expect(readNativeChatComposerDraft(scope('a')).text).toBe('history draft')
  expect(readNativeChatComposerDraft(scope('b')).text).toBe('')
})

it.each(['draft', 'removal'] as const)(
  'keeps journal recovery authoritative after a skipped pre-load clear: %s',
  async (kind) => {
    stop()
    clearNativeChatComposerDraftsForTests()
    const storage = createMemoryNativeChatComposerDraftStorage()
    storage.drafts.set(scope('a'), { text: 'older disk text', images: [], savedAt: 1 })
    localStorage.setItem(
      'orca:nativeChatComposerDraftJournal:v1',
      JSON.stringify([
        {
          scopeKey: scope('a'),
          at: 2,
          run: 'earlier-run',
          draft: kind === 'draft' ? { text: 'newer recovered text', images: [], savedAt: 2 } : null
        }
      ])
    )
    let finish = (): void => {}
    storage.loadAll = () =>
      new Promise((resolve) => {
        const loaded = new Map(storage.drafts)
        finish = () => resolve(loaded)
      })
    storage.read = vi.fn(storage.read)
    setNativeChatComposerDraftStorageForTests(storage)
    useAppStore.setState({ unifiedTabsByWorktree: { [WT]: [chat('a')] } })
    stop = startNativeChatDraftLoad()
    publish(snapshot('b', 'a'))
    expect(storage.read).not.toHaveBeenCalled()
    finish()
    await waitForNativeChatComposerDrafts(1000)
    await settled()
    expect(readNativeChatComposerDraft(scope('a')).text).toBe(
      kind === 'draft' ? 'newer recovered text' : ''
    )
    expect(readNativeChatComposerDraft(scope('b')).text).toBe('')
  }
)
