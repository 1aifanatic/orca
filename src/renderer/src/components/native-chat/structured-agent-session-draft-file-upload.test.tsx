// @vitest-environment happy-dom
import { useRef } from 'react'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useNativeChatComposerAttachments } from './use-native-chat-composer-attachments'
import { attachNativeChatSessionAttachmentPaths } from './native-chat-session-attachment-drop'
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
  clearNativeChatPendingAttachmentsForTests,
  nativeChatPendingAttachmentSnapshot
} from './native-chat-pending-attachment-cache'

// Only host replies are controlled; pending-chip ownership and upload completion are production code.
vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: vi.fn(async () => ({
    runtimeId: 'paired-host',
    capabilities: ['agent-session.attachments.v1']
  }))
}))
beforeEach(async () => {
  setNativeChatComposerDraftStorageForTests(createMemoryNativeChatComposerDraftStorage())
  await hydrateNativeChatComposerDrafts()
})
afterEach(async () => {
  cleanup()
  await nativeChatComposerDraftWritesSettled()
  clearNativeChatPendingAttachmentsForTests()
  clearNativeChatComposerDraftsForTests()
  vi.unstubAllGlobals()
})
async function uploadFixture(extension: string, removed = false) {
  const path = `/srv/agent-session-attachments/u1/report.${extension}`
  const sourcePath = `/local/report.${extension}`
  let finish = () => {}
  vi.stubGlobal('window', {
    api: {
      fs: {
        uploadPathsToAgentSessionAttachments: () =>
          new Promise((resolve) => {
            finish = () => resolve({ uploaded: [{ sourcePath, path }], skipped: [], failed: [] })
          })
      }
    }
  })
  updateNativeChatComposerDraft(scope('a'), { text: 'next question' }, 'immediate')
  const view = renderHook(() => {
    const textareaRef = useRef(null)
    return useNativeChatComposerAttachments({
      attachmentScopeKey: scope('a'),
      allowWithoutTarget: true,
      caret: 0,
      disabled: false,
      isComposing: () => false,
      resolveTarget: () => null,
      textareaRef,
      setCaret: () => {},
      setDraft: (updater) =>
        updateNativeChatComposerDraft(
          scope('a'),
          { text: updater(readNativeChatComposerDraft(scope('a')).text) },
          'immediate'
        ),
      setNotice: () => {}
    })
  })
  let uploaded = Promise.resolve()
  act(() => {
    uploaded = attachNativeChatSessionAttachmentPaths({
      paths: [sourcePath],
      owner: {
        kind: 'runtime-session',
        environmentId: 'paired',
        sessionId: 'a',
        pairingRevision: 1
      },
      chips: view.result.current.pendingChips,
      isAbandoned: () => false,
      ownerStillCurrent: () => true,
      setNotice: () => {}
    })
  })
  await Promise.resolve()
  await Promise.resolve()
  const chip = nativeChatPendingAttachmentSnapshot(scope('a'))[0]
  if (!chip) {
    throw new Error('Expected pending upload chip')
  }
  expect(chip.pendingName).toBe(`report.${extension}`)
  act(() => moveStructuredAgentSessionDraft('a', 'b'))
  expect(nativeChatPendingAttachmentSnapshot(scope('b'))).toMatchObject([
    { id: chip.id, pendingName: `report.${extension}` }
  ])
  if (removed) {
    act(() => view.result.current.removeImageAttachment(chip.id))
  }
  view.unmount()
  finish()
  await uploaded
  return {
    path,
    source: readNativeChatComposerDraft(scope('a')),
    target: readNativeChatComposerDraft(scope('b')),
    pending: nativeChatPendingAttachmentSnapshot(scope('b'))
  }
}
it('a moved paired PDF upload settles its reference into the replacement draft', async () => {
  const result = await uploadFixture('pdf')
  expect(result.pending).toEqual([])
  expect(result.target.text).toContain(`@${result.path}`)
  expect(result.source.text).toBe('')
})
it('control: a moved paired image upload settles into the replacement draft', async () => {
  const result = await uploadFixture('png')
  expect(result.pending).toEqual([])
  expect(result.target.text).toBe('next question')
  expect(result.target.images).toHaveLength(1)
  expect(result.target.images[0].path).toBe(result.path)
  expect(result.source.text).toBe('')
})

it('does not attach a moved file reference the user removed while uploading', async () => {
  const result = await uploadFixture('pdf', true)
  expect(result.pending).toEqual([])
  expect(result.target.text).toBe('next question')
  expect(result.source.text).toBe('')
})
