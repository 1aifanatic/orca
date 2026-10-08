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

it('replays an observed clear after a failed storage load retries successfully', async () => {
  stop()
  clearNativeChatComposerDraftsForTests()
  vi.useFakeTimers()
  const storage = createMemoryNativeChatComposerDraftStorage()
  storage.drafts.set(scope('b'), { text: 'saved in b', images: [], savedAt: 1 })
  storage.loadAll = vi
    .fn()
    .mockRejectedValueOnce(new Error('temporary failure'))
    .mockImplementationOnce(async () => new Map(storage.drafts))
  setNativeChatComposerDraftStorageForTests(storage)
  useAppStore.setState({ unifiedTabsByWorktree: { [WT]: [chat('b')] } })
  stop = startNativeChatDraftLoad()
  publish(snapshot('b', 'a'))
  await waitForNativeChatComposerDrafts(1000)
  publish(snapshot('c', 'b', 2))
  await settled()
  await vi.advanceTimersByTimeAsync(1000)
  await settled()
  expect(readNativeChatComposerDraft(scope('c')).text).toBe('saved in b')
  expect(readNativeChatComposerDraft(scope('b')).text).toBe('')
})

it('collapses repeated observed clears while storage is still loading', async () => {
  stop()
  clearNativeChatComposerDraftsForTests()
  const storage = createMemoryNativeChatComposerDraftStorage()
  storage.drafts.set(scope('a'), { text: 'a to c', images: [], savedAt: 1 })
  let finish = (): void => {}
  storage.loadAll = vi.fn().mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = () => resolve(new Map(storage.drafts))
      })
  )
  setNativeChatComposerDraftStorageForTests(storage)
  useAppStore.setState({ unifiedTabsByWorktree: { [WT]: [chat('a')] } })
  stop = startNativeChatDraftLoad()
  publish(snapshot('b', 'a'))
  publish(snapshot('c', 'b', 2))
  finish()
  await waitForNativeChatComposerDrafts(1000)
  await settled()
  expect(readNativeChatComposerDraft(scope('c')).text).toBe('a to c')
  expect(readNativeChatComposerDraft(scope('a')).text).toBe('')
  expect(readNativeChatComposerDraft(scope('b')).text).toBe('')
})

async function deferredReplacement(): Promise<() => Promise<void>> {
  stop()
  clearNativeChatComposerDraftsForTests()
  const storage = createMemoryNativeChatComposerDraftStorage()
  storage.drafts.set(scope('a'), { text: 'before clear', images: [], savedAt: 1 })
  let finish = (): void => {}
  storage.loadAll = () =>
    new Promise((resolve) => {
      finish = () => resolve(new Map(storage.drafts))
    })
  setNativeChatComposerDraftStorageForTests(storage)
  useAppStore.setState({ unifiedTabsByWorktree: { [WT]: [chat('a')] } })
  stop = startNativeChatDraftLoad()
  publish(snapshot('b', 'a'))
  useAppStore.setState({ unifiedTabsByWorktree: { [WT]: [chat('b'), chat('a', 'history')] } })
  return async () => {
    finish()
    await waitForNativeChatComposerDrafts(1000)
    await settled()
  }
}

it('carries the captured draft while later history text stays in its earlier conversation', async () => {
  const finish = await deferredReplacement()
  updateNativeChatComposerDraft(scope('a'), { text: 'new history input' }, 'immediate')
  useAppStore.setState({ unifiedTabsByWorktree: { [WT]: [chat('b')] } })
  await finish()
  expect(readNativeChatComposerDraft(scope('a')).text).toBe('new history input')
  expect(readNativeChatComposerDraft(scope('b')).text).toBe('before clear')
})

it('leaves a new history upload where it began when the captured move drains', async () => {
  const finish = await deferredReplacement()
  addNativeChatPendingAttachment(scope('a'), { id: 'history-image', path: '', pending: true })
  await finish()
  settleNativeChatPendingAttachment(scope('a'), 'history-image', '/ssh/history.png', 'ssh-1')
  expect(readNativeChatComposerDraft(scope('a')).images).toEqual([
    { id: 'history-image', path: '/ssh/history.png', connectionId: 'ssh-1' }
  ])
  expect(readNativeChatComposerDraft(scope('b')).images).toEqual([])
})

it('keeps history uploads that settle before the saved-draft load completes', async () => {
  const finish = await deferredReplacement()
  addNativeChatPendingAttachment(scope('a'), { id: 'history-image', path: '', pending: true })
  settleNativeChatPendingAttachment(scope('a'), 'history-image', '/ssh/history.png', 'ssh-1')
  await finish()
  expect(readNativeChatComposerDraft(scope('a')).images).toEqual([
    { id: 'history-image', path: '/ssh/history.png', connectionId: 'ssh-1' }
  ])
  expect(readNativeChatComposerDraft(scope('b')).images).toEqual([])
  expect(readNativeChatComposerDraft(scope('b')).text).toBe('before clear')
})
