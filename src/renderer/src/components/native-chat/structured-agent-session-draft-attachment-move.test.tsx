// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it } from 'vitest'
import { cleanup, renderHook } from '@testing-library/react'
import { useNativeChatPasteLifetime } from './use-native-chat-paste-lifetime'
import { moveStructuredAgentSessionDraft } from './structured-agent-session-draft-move'
import {
  clearNativeChatComposerDraftsForTests,
  hydrateNativeChatComposerDrafts,
  readNativeChatComposerDraft,
  updateNativeChatComposerDraft,
  structuredAgentSessionDraftScopeKey as scope
} from './native-chat-composer-draft-store'
import {
  createMemoryNativeChatComposerDraftStorage,
  setNativeChatComposerDraftStorageForTests
} from './native-chat-composer-draft-storage'
import {
  addNativeChatPendingAttachment,
  clearNativeChatPendingAttachmentsForTests,
  nativeChatPendingAttachmentSnapshot,
  revealNativeChatPendingAttachment,
  settleNativeChatPendingAttachment,
  takeNativeChatPendingAttachment
} from './native-chat-pending-attachment-cache'

beforeEach(async () => {
  setNativeChatComposerDraftStorageForTests(createMemoryNativeChatComposerDraftStorage())
  await hydrateNativeChatComposerDrafts()
})
afterEach(() => {
  cleanup()
  clearNativeChatPendingAttachmentsForTests()
  clearNativeChatComposerDraftsForTests()
})

it.each(['local', 'paired'] as const)(
  'keeps a pending-only %s paste whose upload settles after replacement unmounts the composer',
  async (host) => {
    const view = renderHook(() =>
      useNativeChatPasteLifetime({
        targetKey: 'a',
        attachmentScopeKey: scope('a'),
        beginPendingImageAttachment: () => 'upload',
        resolvePendingImageAttachment: (id, path, connection) => {
          settleNativeChatPendingAttachment(scope('a'), id, path, connection)
        },
        dropPendingImageAttachment: (id) => {
          takeNativeChatPendingAttachment(scope('a'), id)
        }
      })
    )
    const lifetime = view.result.current
    addNativeChatPendingAttachment(scope('a'), { id: 'upload', path: '', pending: true })
    lifetime.track(
      'upload',
      '',
      host === 'paired'
        ? { kind: 'runtime-session', environmentId: 'paired', sessionId: 'a', pairingRevision: 1 }
        : { kind: 'local' }
    )
    await moveStructuredAgentSessionDraft('a', 'b')
    expect(nativeChatPendingAttachmentSnapshot(scope('a'))).toEqual([])
    expect(nativeChatPendingAttachmentSnapshot(scope('b'))).toMatchObject([
      { id: 'upload', pending: true }
    ])
    view.unmount()
    expect(
      lifetime.keepStoreUploadAfterUnmount('upload', {
        status: 'saved',
        tempPath: '/stored/image.png'
      })
    ).toBe(true)
    expect(readNativeChatComposerDraft(scope('b')).images).toEqual([
      { id: 'upload', path: '/stored/image.png' }
    ])
    expect(readNativeChatComposerDraft(scope('a')).images).toEqual([])
    expect(nativeChatPendingAttachmentSnapshot(scope('b'))).toEqual([])
  }
)

it('keeps original upload callbacks through repeated clears and reveal', async () => {
  addNativeChatPendingAttachment(scope('a'), {
    id: 'upload',
    path: '',
    pending: true,
    hidden: true
  })
  await moveStructuredAgentSessionDraft('a', 'b')
  await moveStructuredAgentSessionDraft('b', 'c')
  revealNativeChatPendingAttachment(scope('a'), 'upload')
  expect(nativeChatPendingAttachmentSnapshot(scope('c'))).toEqual([
    { id: 'upload', path: '', pending: true }
  ])
  expect(settleNativeChatPendingAttachment(scope('a'), 'upload', '/ssh/image.png', 'ssh-1')).toBe(
    true
  )
  expect(readNativeChatComposerDraft(scope('c')).images).toEqual([
    { id: 'upload', path: '/ssh/image.png', connectionId: 'ssh-1' }
  ])
})

it('does not attach a moved upload the user already removed', async () => {
  addNativeChatPendingAttachment(scope('a'), { id: 'upload', path: '', pending: true })
  await moveStructuredAgentSessionDraft('a', 'b')
  takeNativeChatPendingAttachment(scope('b'), 'upload')
  expect(settleNativeChatPendingAttachment(scope('a'), 'upload', '/stored/image.png')).toBe(false)
  expect(readNativeChatComposerDraft(scope('a')).images).toEqual([])
  expect(readNativeChatComposerDraft(scope('b')).images).toEqual([])
})

it('keeps source ownership when the replacement already holds a pending upload', () => {
  updateNativeChatComposerDraft(scope('a'), { text: 'source history draft' }, 'immediate')
  addNativeChatPendingAttachment(scope('a'), { id: 'source-upload', path: '', pending: true })
  addNativeChatPendingAttachment(scope('b'), { id: 'target-upload', path: '', pending: true })
  moveStructuredAgentSessionDraft('a', 'b')
  expect(readNativeChatComposerDraft(scope('a')).text).toBe('source history draft')
  expect(readNativeChatComposerDraft(scope('b')).text).toBe('')
  expect(nativeChatPendingAttachmentSnapshot(scope('a'))).toMatchObject([{ id: 'source-upload' }])
  expect(nativeChatPendingAttachmentSnapshot(scope('b'))).toMatchObject([{ id: 'target-upload' }])
  settleNativeChatPendingAttachment(scope('a'), 'source-upload', '/ssh/source.png', 'ssh-1')
  settleNativeChatPendingAttachment(scope('b'), 'target-upload', '/ssh/target.png', 'ssh-1')
  expect(readNativeChatComposerDraft(scope('a')).images[0]?.path).toBe('/ssh/source.png')
  expect(readNativeChatComposerDraft(scope('b')).images[0]?.path).toBe('/ssh/target.png')
})
