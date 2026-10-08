// @vitest-environment happy-dom
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { useNativeChatPasteLifetime } from './use-native-chat-paste-lifetime'
import { moveStructuredAgentSessionDraft } from './structured-agent-session-draft-move'
import {
  clearNativeChatComposerDraftsForTests,
  hydrateNativeChatComposerDrafts,
  nativeChatComposerDraftWritesSettled,
  readNativeChatComposerDraft,
  structuredAgentSessionDraftScopeKey as scope,
  updateNativeChatComposerDraft
} from './native-chat-composer-draft-store'
import {
  createMemoryNativeChatComposerDraftStorage,
  setNativeChatComposerDraftStorageForTests
} from './native-chat-composer-draft-storage'
import {
  addNativeChatPendingAttachment,
  clearNativeChatPendingAttachmentsForTests,
  nativeChatPendingAttachmentSnapshot,
  settleNativeChatPendingAttachment,
  takeNativeChatPendingAttachment
} from './native-chat-pending-attachment-cache'
import type { NativeChatAttachmentOwner } from './native-chat-attachment-upload'

beforeEach(async () => {
  setNativeChatComposerDraftStorageForTests(createMemoryNativeChatComposerDraftStorage())
  await hydrateNativeChatComposerDrafts()
})
afterEach(async () => {
  cleanup()
  await nativeChatComposerDraftWritesSettled()
  clearNativeChatPendingAttachmentsForTests()
  clearNativeChatComposerDraftsForTests()
})
const owners: Record<string, NativeChatAttachmentOwner> = {
  local: { kind: 'local' },
  ssh: {
    kind: 'ssh',
    connectionId: 'ssh-1',
    worktreePath: '/remote/worktree',
    expectedExecutionHostId: 'ssh:ssh-1',
    expectedSshTargetId: 'ssh-1',
    expectedSshConnectionGeneration: 1
  },
  paired: { kind: 'runtime-session', environmentId: 'paired', sessionId: 'a', pairingRevision: 1 }
}
async function fixture(host: string, reason: string, removed = false, status = 'saved') {
  let releaseLoad = () => {}
  let loading = Promise.resolve()
  if (reason === 'preload') {
    clearNativeChatComposerDraftsForTests()
    const storage = createMemoryNativeChatComposerDraftStorage()
    const held = new Promise<void>((resolve) => {
      releaseLoad = resolve
    })
    setNativeChatComposerDraftStorageForTests({
      ...storage,
      loadAll: async () => {
        await held
        return storage.loadAll()
      }
    })
    loading = hydrateNativeChatComposerDrafts()
  }
  updateNativeChatComposerDraft(scope('a'), { text: 'source history text' }, 'immediate')
  if (reason === 'target-text') {
    updateNativeChatComposerDraft(scope('b'), { text: 'target input' }, 'immediate')
  }
  if (reason === 'target-pending') {
    addNativeChatPendingAttachment(scope('b'), { id: 'target', path: '', pending: true })
  }
  const view = renderHook(() =>
    useNativeChatPasteLifetime({
      targetKey: 'a',
      attachmentScopeKey: scope('a'),
      beginPendingImageAttachment: () => 'source',
      resolvePendingImageAttachment: (id, path, connectionId) => {
        settleNativeChatPendingAttachment(scope('a'), id, path, connectionId)
      },
      dropPendingImageAttachment: (id) => {
        takeNativeChatPendingAttachment(scope('a'), id)
      }
    })
  )
  const lifetime = view.result.current
  addNativeChatPendingAttachment(scope('a'), { id: 'source', path: '', pending: true })
  const owner = owners[host]
  if (!owner) {
    throw new Error('Expected upload owner')
  }
  lifetime.track('source', '', owner)
  moveStructuredAgentSessionDraft('a', 'b')
  if (removed) {
    takeNativeChatPendingAttachment(scope('a'), 'source')
  }
  const before = nativeChatPendingAttachmentSnapshot(scope('a')).map((chip) => chip.id)
  view.unmount()
  const after = nativeChatPendingAttachmentSnapshot(scope('a')).map((chip) => chip.id)
  const kept = lifetime.keepStoreUploadAfterUnmount('source', {
    status,
    tempPath: '/stored/image.png'
  })
  releaseLoad()
  await loading
  return {
    before,
    after,
    kept,
    source: readNativeChatComposerDraft(scope('a')),
    target: readNativeChatComposerDraft(scope('b'))
  }
}
it.each(
  ['preload', 'target-text', 'target-pending'].flatMap((reason) =>
    ['local', 'ssh', 'paired'].map((host) => ({ reason, host }))
  )
)('skipped clear preserves $host pending upload in source ($reason)', async ({ host, reason }) => {
  const result = await fixture(host, reason)
  expect(result.before).toEqual(['source'])
  expect(result.after).toEqual(['source'])
  expect(result.kept).toBe(true)
  expect(result.source.text).toBe('source history text')
  expect(result.source.images).toEqual([
    {
      id: 'source',
      path: '/stored/image.png',
      ...(host === 'ssh' ? { connectionId: 'ssh-1' } : {})
    }
  ])
  expect(result.target.images).toEqual([])
})
it.each(['local', 'ssh'])(
  'control: moved $s upload survives teardown and settles in destination',
  async (host) => {
    const result = await fixture(host, 'empty')
    expect(result.source.text).toBe('')
    expect(result.source.images).toEqual([])
    expect(result.target.images).toEqual([
      {
        id: 'source',
        path: '/stored/image.png',
        ...(host === 'ssh' ? { connectionId: 'ssh-1' } : {})
      }
    ])
  }
)

it.each(['local', 'ssh'])('does not settle a removed %s upload after teardown', async (host) => {
  const result = await fixture(host, 'target-text', true)
  expect(result.kept).toBe(false)
  expect(result.source.images).toEqual([])
  expect(result.target.images).toEqual([])
})
it.each(['local', 'ssh'])('drops a failed %s upload after teardown', async (host) => {
  const result = await fixture(host, 'target-text', false, 'error')
  expect(result.kept).toBe(true)
  expect(nativeChatPendingAttachmentSnapshot(scope('a'))).toEqual([])
  expect(result.source.images).toEqual([])
  expect(result.target.images).toEqual([])
})
