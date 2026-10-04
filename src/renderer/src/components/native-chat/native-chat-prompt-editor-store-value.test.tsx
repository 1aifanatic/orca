// @vitest-environment happy-dom
// A value the field sets on the editor comes from the draft store, so the editor never saves it
// back: an echo would make another window's draft, or a late-loaded one, a change of this window.
import { createElement, createRef } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as DraftStore from './native-chat-composer-draft-store'
import type * as DraftCache from './native-chat-draft-cache'
import type { NativeChatComposerInput } from './native-chat-composer-input'
import { createMemoryNativeChatComposerDraftStorage } from './native-chat-composer-draft-storage'

type Renderer = { drafts: typeof DraftCache; store: typeof DraftStore }

const SCOPE = 'agent-session:s1'
let storage = createMemoryNativeChatComposerDraftStorage()
const loaded: Renderer[] = []

async function open(): Promise<Renderer> {
  vi.resetModules()
  const storageModule = await import('./native-chat-composer-draft-storage')
  storageModule.setNativeChatComposerDraftStorageForTests(storage)
  const renderer = {
    drafts: await import('./native-chat-draft-cache'),
    store: await import('./native-chat-composer-draft-store')
  }
  loaded.push(renderer)
  await renderer.store.hydrateNativeChatComposerDrafts()
  return renderer
}

/** The editor, plus the field's effect that sets the store's draft on it. */
async function mountEditor(renderer: Renderer): Promise<() => void> {
  const { NativeChatPromptEditor } = await import('./NativeChatPromptEditor')
  const inputRef = createRef<NativeChatComposerInput>()
  render(
    createElement(NativeChatPromptEditor, {
      scopeKey: SCOPE,
      inputRef,
      initialValue: renderer.drafts.readNativeChatDraftCache(SCOPE),
      disabled: false,
      placeholder: 'Message',
      onChange: () => {},
      onSelect: () => {}
    })
  )
  return renderer.store.subscribeToNativeChatComposerDraft(SCOPE, () => {
    const draft = renderer.drafts.readNativeChatDraftCache(SCOPE)
    if (inputRef.current && inputRef.current.value !== draft) {
      inputRef.current.value = draft
    }
  })
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

beforeEach(() => {
  localStorage.clear()
  storage = createMemoryNativeChatComposerDraftStorage()
})

afterEach(() => {
  cleanup()
  for (const renderer of loaded.splice(0)) {
    renderer.store.clearNativeChatComposerDraftsForTests()
  }
})

describe('the editor and the draft store', () => {
  it('saves nothing when the store’s draft is set on the editor', async () => {
    const renderer = await open()
    const stopSync = await mountEditor(renderer)
    await act(async () => renderer.drafts.appendNativeChatDraftCache(SCOPE, 'hello'))
    await renderer.store.nativeChatComposerDraftWritesSettled()
    const savedAt = storage.drafts.get(SCOPE)?.savedAt

    await act(async () => pause(400))
    await renderer.store.nativeChatComposerDraftWritesSettled()
    stopSync()
    expect(storage.drafts.get(SCOPE)?.savedAt).toBe(savedAt)
  })

  it('lets another window’s send stand, instead of echoing back the draft it showed', async () => {
    const receiving = await open()
    const stopSync = await mountEditor(receiving)
    const sending = await open()
    sending.drafts.writeNativeChatDraftCache(SCOPE, 'hello')
    sending.store.flushNativeChatComposerDrafts()
    await act(async () => {
      await vi.waitFor(() => expect(receiving.drafts.readNativeChatDraftCache(SCOPE)).toBe('hello'))
    })

    sending.drafts.writeNativeChatDraftCache(SCOPE, '')
    await sending.store.nativeChatComposerDraftWritesSettled()
    await act(async () => pause(600))
    await receiving.store.nativeChatComposerDraftWritesSettled()
    await act(async () => pause(50))
    stopSync()

    expect(storage.drafts.has(SCOPE)).toBe(false)
    expect(sending.drafts.readNativeChatDraftCache(SCOPE)).toBe('')
    expect(receiving.drafts.readNativeChatDraftCache(SCOPE)).toBe('')
  })

  it('shows a draft that arrives later with its skill chip, from its saved document', async () => {
    const document = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'nativeChatSkill', attrs: { token: '$review' } },
            { type: 'text', text: ' this' }
          ]
        }
      ]
    }
    const receiving = await open()
    const stopSync = await mountEditor(receiving)
    const sending = await open()
    sending.drafts.writeNativeChatDraftDocument(SCOPE, '$review this', document)
    sending.store.flushNativeChatComposerDrafts()
    await act(async () => {
      await vi.waitFor(() =>
        expect(receiving.drafts.readNativeChatDraftCache(SCOPE)).toBe('$review this')
      )
    })
    stopSync()

    expect(window.document.querySelector('[data-native-chat-skill]')).not.toBeNull()
    expect(storage.drafts.get(SCOPE)?.document).toEqual(document)
  })
})
