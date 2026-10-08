// @vitest-environment happy-dom
import { afterEach, expect, it } from 'vitest'
import { captureNativeChatDraftTransfer } from './native-chat-draft-transfer-snapshot'
import {
  clearNativeChatComposerDraftsForTests,
  hydrateNativeChatComposerDrafts,
  updateNativeChatComposerDraft
} from './native-chat-composer-draft-store'
import {
  createMemoryNativeChatComposerDraftStorage,
  setNativeChatComposerDraftStorageForTests
} from './native-chat-composer-draft-storage'

afterEach(clearNativeChatComposerDraftsForTests)

it('captures a saved record before a later history write even while startup has not loaded', async () => {
  const storage = createMemoryNativeChatComposerDraftStorage()
  storage.drafts.set('source', { text: 'before switch', images: [], savedAt: 1 })
  setNativeChatComposerDraftStorageForTests(storage)
  const captured = captureNativeChatDraftTransfer('source')
  await storage.write('source', { text: 'later history', images: [], savedAt: 2 })
  expect(await captured).toEqual({
    draft: { text: 'before switch', images: [], savedAt: 1 },
    unverified: true
  })
})

it('freezes memory input without depending on a disk read', async () => {
  const storage = createMemoryNativeChatComposerDraftStorage()
  setNativeChatComposerDraftStorageForTests(storage)
  await hydrateNativeChatComposerDrafts()
  storage.read = async () => {
    throw new Error('unavailable')
  }
  updateNativeChatComposerDraft('source', { text: 'before switch' }, 'immediate')
  const captured = captureNativeChatDraftTransfer('source')
  updateNativeChatComposerDraft('source', { text: 'later history' }, 'immediate')
  expect(await captured).toMatchObject({ draft: { text: 'before switch' }, unverified: false })
})

it('reports a failed saved-record capture rather than reading a later scope value', async () => {
  const storage = createMemoryNativeChatComposerDraftStorage()
  storage.read = async () => {
    throw new Error('unavailable')
  }
  setNativeChatComposerDraftStorageForTests(storage)
  await expect(captureNativeChatDraftTransfer('source')).rejects.toThrow('unavailable')
  expect(storage.drafts.size).toBe(0)
})
