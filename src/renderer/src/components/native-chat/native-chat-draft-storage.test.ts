// @vitest-environment happy-dom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { NATIVE_CHAT_COMPOSER_SCOPE_CACHE_MAX } from './native-chat-composer-scope-cache'
import type * as DraftCache from './native-chat-draft-cache'
import type * as DraftStorage from './native-chat-draft-storage'
import type * as ComposerAttachments from './use-native-chat-composer-attachments'

const DRAFT_KEY_PREFIX = 'orca:nativeChatComposerDraft:v1:'

type DraftModules = {
  drafts: typeof DraftCache
  attachments: typeof ComposerAttachments
  storage: typeof DraftStorage
}

/** A fresh renderer: module memory is gone, localStorage is not. */
async function reload(): Promise<DraftModules> {
  vi.resetModules()
  return {
    drafts: await import('./native-chat-draft-cache'),
    attachments: await import('./use-native-chat-composer-attachments'),
    storage: await import('./native-chat-draft-storage')
  }
}

function storedDraftKeys(): string[] {
  return Object.keys(localStorage).filter((key) => key.startsWith(DRAFT_KEY_PREFIX))
}

let modules: DraftModules

// The attachment module's import graph is slow to transform cold; later reloads reuse it.
beforeAll(async () => {
  await reload()
}, 300_000)

beforeEach(async () => {
  localStorage.clear()
  modules = await reload()
})

afterEach(() => {
  vi.useRealTimers()
  localStorage.clear()
})

describe('native-chat draft storage', () => {
  it('keeps a typed draft across a reload once its debounced write lands', async () => {
    vi.useFakeTimers()
    modules.drafts.writeNativeChatDraftCache('tab-1:pane', 'half a thought')
    expect(storedDraftKeys()).toEqual([])
    vi.advanceTimersByTime(250)

    const reloaded = await reload()
    expect(reloaded.drafts.readNativeChatDraftCache('tab-1:pane')).toBe('half a thought')
  })

  it('writes a still-debounced draft when the window goes away', async () => {
    vi.useFakeTimers()
    modules.drafts.writeNativeChatDraftCache('tab-1:pane', 'typed just before reload')
    window.dispatchEvent(new Event('pagehide'))

    const reloaded = await reload()
    expect(reloaded.drafts.readNativeChatDraftCache('tab-1:pane')).toBe('typed just before reload')
  })

  it('saves text and images given back to the composer at once, before their other copy goes', async () => {
    vi.useFakeTimers()
    modules.drafts.appendNativeChatDraftCache('tab-1:pane', 'withdrawn by Stop')
    modules.attachments.appendNativeChatAttachmentCache('tab-1:pane', [
      { id: 'withdrawn-a-1', path: '/repo/shot.png' },
      { id: 'withdrawn-a-2', path: '/tmp/orca-paste-1.png', connectionId: 'ssh-1' }
    ])

    // No timer advanced: a crash right after the restore still keeps it.
    const reloaded = await reload()
    expect(reloaded.drafts.readNativeChatDraftCache('tab-1:pane')).toBe('withdrawn by Stop')
    expect(reloaded.attachments.readNativeChatAttachmentCache('tab-1:pane')).toEqual([
      { id: 'withdrawn-a-1', path: '/repo/shot.png' },
      { id: 'withdrawn-a-2', path: '/tmp/orca-paste-1.png', connectionId: 'ssh-1' }
    ])
  })

  it('appends a given-back message after a draft restored from a reload', async () => {
    modules.drafts.writeNativeChatDraftCache('tab-1:pane', 'mine')
    modules.storage.flushPersistedNativeChatDrafts()

    const reloaded = await reload()
    reloaded.drafts.appendNativeChatDraftCache('tab-1:pane', 'returned')
    expect(reloaded.drafts.readNativeChatDraftCache('tab-1:pane')).toBe('mine\n\nreturned')
  })

  it('removes the saved draft as soon as it is sent or emptied', async () => {
    modules.drafts.writeNativeChatDraftCache('tab-1:pane', 'about to send')
    modules.storage.flushPersistedNativeChatDrafts()
    modules.drafts.writeNativeChatDraftCache('tab-1:pane', '')

    expect(storedDraftKeys()).toEqual([])
    const reloaded = await reload()
    expect(reloaded.drafts.readNativeChatDraftCache('tab-1:pane')).toBe('')
  })

  it('keeps the images when only the text is cleared', async () => {
    modules.drafts.writeNativeChatDraftCache('tab-1:pane', 'caption')
    modules.attachments.appendNativeChatAttachmentCache('tab-1:pane', [
      { id: 'a', path: '/repo/a.png' }
    ])
    modules.drafts.writeNativeChatDraftCache('tab-1:pane', '')

    const reloaded = await reload()
    expect(reloaded.drafts.readNativeChatDraftCache('tab-1:pane')).toBe('')
    expect(reloaded.attachments.readNativeChatAttachmentCache('tab-1:pane')).toEqual([
      { id: 'a', path: '/repo/a.png' }
    ])
  })

  it('restores the editor document with its text', async () => {
    const document = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'with /skill' }] }]
    }
    modules.drafts.writeNativeChatDraftDocument('tab-1:pane', 'with /skill', document)
    modules.storage.flushPersistedNativeChatDrafts()

    const reloaded = await reload()
    expect(reloaded.drafts.readNativeChatDraftDocument('tab-1:pane', 'with /skill')).toEqual(
      document
    )
  })

  it('keeps an oversized draft in memory only, so it never crowds the outbox out of storage', async () => {
    const huge = 'x'.repeat(250_000)
    modules.drafts.writeNativeChatDraftCache('tab-1:pane', huge)
    modules.storage.flushPersistedNativeChatDrafts()

    expect(modules.drafts.readNativeChatDraftCache('tab-1:pane')).toBe(huge)
    expect(storedDraftKeys()).toEqual([])
  })

  it('keeps only the newest drafts and drops unreadable ones', async () => {
    localStorage.setItem(`${DRAFT_KEY_PREFIX}broken`, '{not json')
    const total = NATIVE_CHAT_COMPOSER_SCOPE_CACHE_MAX + 5
    vi.useFakeTimers()
    for (let index = 0; index < total; index += 1) {
      vi.setSystemTime(1_000 + index)
      modules.drafts.writeNativeChatDraftCache(`scope-${index}`, `draft-${index}`)
      modules.storage.flushPersistedNativeChatDrafts()
    }

    const keys = storedDraftKeys()
    expect(keys).toHaveLength(NATIVE_CHAT_COMPOSER_SCOPE_CACHE_MAX)
    expect(keys).not.toContain(`${DRAFT_KEY_PREFIX}broken`)
    expect(keys).not.toContain(`${DRAFT_KEY_PREFIX}scope-0`)
    expect(keys).toContain(`${DRAFT_KEY_PREFIX}scope-${total - 1}`)
  })

  it('keeps working from memory when storage refuses the write', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError')
    })
    try {
      modules.drafts.writeNativeChatDraftCache('tab-1:pane', 'still here')
      expect(() => modules.storage.flushPersistedNativeChatDrafts()).not.toThrow()
      expect(modules.drafts.readNativeChatDraftCache('tab-1:pane')).toBe('still here')
    } finally {
      setItem.mockRestore()
    }
  })
})
