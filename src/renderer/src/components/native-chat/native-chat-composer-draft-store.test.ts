// @vitest-environment happy-dom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as DraftStore from './native-chat-composer-draft-store'
import type * as DraftCache from './native-chat-draft-cache'
import type * as ComposerAttachments from './use-native-chat-composer-attachments'
import { MAX_PROMPT_BYTES } from '../../../../shared/rpc-contract/structured-agent-session-params'
import {
  createMemoryNativeChatComposerDraftStorage,
  type NativeChatComposerDraftStorage
} from './native-chat-composer-draft-storage'

type DraftModules = {
  drafts: typeof DraftCache
  attachments: typeof ComposerAttachments
  store: typeof DraftStore
}

let storage: ReturnType<typeof createMemoryNativeChatComposerDraftStorage>
const loaded: DraftModules[] = []

/** A fresh renderer: module memory is gone, the drafts' storage is not. */
async function reload(
  options: { using?: NativeChatComposerDraftStorage; hydrate?: boolean } = {}
): Promise<DraftModules> {
  vi.resetModules()
  const storageModule = await import('./native-chat-composer-draft-storage')
  storageModule.setNativeChatComposerDraftStorageForTests(options.using ?? storage)
  const modules = {
    drafts: await import('./native-chat-draft-cache'),
    attachments: await import('./use-native-chat-composer-attachments'),
    store: await import('./native-chat-composer-draft-store')
  }
  loaded.push(modules)
  if (options.hydrate !== false) {
    await modules.store.hydrateNativeChatComposerDrafts()
  }
  return modules
}

function storedDraft(scopeKey: string): Record<string, unknown> | null {
  return storage.drafts.get(scopeKey) ?? null
}

const IMAGES = [
  { id: 'a-1', path: '/repo/shot.png' },
  { id: 'a-2', path: '/remote/repo/diagram.png', connectionId: 'ssh-1' }
]

const SKILL_DOCUMENT = {
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'with /skill' }] }]
}

let modules: DraftModules

// The attachment module's import graph is slow to transform cold; later reloads reuse it.
beforeAll(async () => {
  storage = createMemoryNativeChatComposerDraftStorage()
  await reload()
}, 300_000)

beforeEach(async () => {
  localStorage.clear()
  storage = createMemoryNativeChatComposerDraftStorage()
  modules = await reload()
})

afterEach(() => {
  vi.useRealTimers()
  // Each loaded renderer closes its channel, so it hears nothing from the next test.
  for (const instance of loaded.splice(0)) {
    instance.store.clearNativeChatComposerDraftsForTests()
  }
})

describe('native-chat composer draft store', () => {
  it('gives back the text, its editor document and the images after a reload', async () => {
    vi.useFakeTimers()
    modules.attachments.appendNativeChatAttachmentCache('tab-1:pane', IMAGES)
    modules.drafts.writeNativeChatDraftDocument('tab-1:pane', 'with /skill', SKILL_DOCUMENT)
    modules.drafts.writeNativeChatDraftCache('tab-1:pane', 'with /skill')
    expect(storedDraft('tab-1:pane')?.text).toBe('')
    vi.advanceTimersByTime(250)
    vi.useRealTimers()

    const reloaded = await reload()
    expect(reloaded.drafts.readNativeChatDraftCache('tab-1:pane')).toBe('with /skill')
    expect(reloaded.drafts.readNativeChatDraftDocument('tab-1:pane', 'with /skill')).toEqual(
      SKILL_DOCUMENT
    )
    expect(reloaded.attachments.readNativeChatAttachmentCache('tab-1:pane')).toEqual(IMAGES)
  })

  it('writes a still-deferred draft when the window goes away', async () => {
    vi.useFakeTimers()
    modules.drafts.writeNativeChatDraftCache('tab-1:pane', 'typed just before reload')
    window.dispatchEvent(new Event('pagehide'))
    vi.useRealTimers()

    const reloaded = await reload()
    expect(reloaded.drafts.readNativeChatDraftCache('tab-1:pane')).toBe('typed just before reload')
  })

  it('replays a change storage had not confirmed when the window went away', async () => {
    const uncommitted = createMemoryNativeChatComposerDraftStorage()
    // A write the backend never finished: its promise never settles, and nothing lands.
    uncommitted.write = () => new Promise(() => {})
    const lost = await reload({ using: uncommitted })
    lost.drafts.writeNativeChatDraftCache('tab-1:pane', 'typed, then Orca quit')
    window.dispatchEvent(new Event('pagehide'))
    expect(uncommitted.drafts.size).toBe(0)

    const reloaded = await reload()
    expect(reloaded.drafts.readNativeChatDraftCache('tab-1:pane')).toBe('typed, then Orca quit')
    await reloaded.store.nativeChatComposerDraftWritesSettled()
    expect(storedDraft('tab-1:pane')?.text).toBe('typed, then Orca quit')
    expect(localStorage.length).toBe(0)
  })

  it('saves text and images given back to the composer at once, before their other copy goes', async () => {
    vi.useFakeTimers()
    // No timer advanced: a crash right after either restore still keeps it.
    modules.drafts.appendNativeChatDraftCache('tab-1:pane', 'withdrawn by Stop')
    expect(storedDraft('tab-1:pane')?.text).toBe('withdrawn by Stop')
    modules.attachments.appendNativeChatAttachmentCache('tab-1:pane', IMAGES)
    vi.useRealTimers()

    const reloaded = await reload()
    expect(reloaded.drafts.readNativeChatDraftCache('tab-1:pane')).toBe('withdrawn by Stop')
    expect(reloaded.attachments.readNativeChatAttachmentCache('tab-1:pane')).toEqual(IMAGES)
  })

  it('brings a pasted image back after a reload as one to attach again, by name', async () => {
    const pasted = { id: 'p-1', path: '/var/folders/T/orca-paste-1-0f.png' }
    modules.attachments.appendNativeChatAttachmentCache('tab-1:pane', [pasted, IMAGES[0]])
    modules.drafts.writeNativeChatDraftCache('tab-1:pane', 'caption')
    modules.store.flushNativeChatComposerDrafts()

    expect(modules.attachments.readNativeChatAttachmentCache('tab-1:pane')).toEqual([
      pasted,
      IMAGES[0]
    ])
    const reloaded = await reload()
    expect(reloaded.attachments.readNativeChatAttachmentCache('tab-1:pane')).toEqual([
      { id: 'p-1', path: '', unavailableName: 'orca-paste-1-0f.png' },
      IMAGES[0]
    ])
  })

  it('keeps a draft that holds only a pasted image, as one to attach again', async () => {
    modules.attachments.appendNativeChatAttachmentCache('tab-1:pane', [
      { id: 'p-1', path: '/tmp/orca-paste-1-0f.png', connectionId: 'ssh-1' }
    ])

    const reloaded = await reload()
    expect(reloaded.attachments.readNativeChatAttachmentCache('tab-1:pane')).toEqual([
      { id: 'p-1', path: '', unavailableName: 'orca-paste-1-0f.png' }
    ])
  })

  it('saves a paste kept in Orca’s paste folder as the real image, but not one over SSH', async () => {
    const kept = {
      id: 'p-1',
      path: '/Users/me/Library/Application Support/orca/native-chat-pastes/orca-paste-1-0f.png'
    }
    const remote = {
      id: 'p-2',
      path: '/remote/native-chat-pastes/orca-paste-2-0f.png',
      connectionId: 'ssh-1'
    }
    modules.attachments.appendNativeChatAttachmentCache('tab-1:pane', [kept, remote])

    const reloaded = await reload()
    expect(reloaded.attachments.readNativeChatAttachmentCache('tab-1:pane')).toEqual([
      kept,
      { id: 'p-2', path: '', unavailableName: 'orca-paste-2-0f.png' }
    ])
  })

  it('puts a re-attached image in the place of the one to attach again', async () => {
    storage.drafts.set('tab-1:pane', {
      text: 'see',
      images: [{ id: 'm', path: '', unavailableName: 'shot.png' }, IMAGES[0]],
      savedAt: 1
    })
    const reloaded = await reload()

    reloaded.attachments.appendNativeChatAttachmentCache(
      'tab-1:pane',
      [{ id: 'again', path: '/Users/me/Desktop/shot.png' }],
      { fromUser: true }
    )
    expect(reloaded.attachments.readNativeChatAttachmentCache('tab-1:pane')).toEqual([
      { id: 'again', path: '/Users/me/Desktop/shot.png' },
      IMAGES[0]
    ])
  })

  it('adds an image Stop gives back next to a placeholder with its name, never in its place', async () => {
    storage.drafts.set('tab-1:pane', {
      text: 'compare with this',
      images: [{ id: 'm', path: '', unavailableName: 'image.png' }],
      savedAt: 1
    })
    const reloaded = await reload()

    reloaded.attachments.appendNativeChatAttachmentCache('tab-1:pane', [
      { id: 'withdrawn-cm-1-1', path: '/Users/me/Downloads/image.png' }
    ])
    expect(reloaded.attachments.readNativeChatAttachmentCache('tab-1:pane')).toEqual([
      { id: 'm', path: '', unavailableName: 'image.png' },
      { id: 'withdrawn-cm-1-1', path: '/Users/me/Downloads/image.png' }
    ])
  })

  it('appends a given-back message after a draft restored from a reload', async () => {
    modules.drafts.writeNativeChatDraftCache('tab-1:pane', 'mine')
    modules.store.flushNativeChatComposerDrafts()

    const reloaded = await reload()
    reloaded.drafts.appendNativeChatDraftCache('tab-1:pane', 'returned')
    expect(reloaded.drafts.readNativeChatDraftCache('tab-1:pane')).toBe('mine\n\nreturned')
  })

  it('removes the saved draft as soon as it is sent, even with a typed change still deferred', async () => {
    vi.useFakeTimers()
    modules.attachments.appendNativeChatAttachmentCache('tab-1:pane', IMAGES)
    modules.drafts.writeNativeChatDraftCache('tab-1:pane', 'about to send')
    modules.store.flushNativeChatComposerDrafts()
    modules.drafts.writeNativeChatDraftCache('tab-1:pane', 'about to send!')

    // The send clears the text, then the images; the text clear lands before any timer.
    modules.drafts.writeNativeChatDraftCache('tab-1:pane', '')
    expect(storedDraft('tab-1:pane')).toMatchObject({ text: '', images: IMAGES })
    modules.store.updateNativeChatComposerDraft('tab-1:pane', { images: [] }, 'immediate')
    expect(storage.drafts.size).toBe(0)

    vi.advanceTimersByTime(1_000)
    expect(storage.drafts.size).toBe(0)
    vi.useRealTimers()
    const reloaded = await reload()
    expect(reloaded.drafts.readNativeChatDraftCache('tab-1:pane')).toBe('')
    expect(reloaded.attachments.readNativeChatAttachmentCache('tab-1:pane')).toEqual([])
  })

  it('removes an emptied draft without waiting for a flush', () => {
    vi.useFakeTimers()
    modules.drafts.writeNativeChatDraftCache('tab-1:pane', 'about to send')
    modules.store.flushNativeChatComposerDrafts()
    modules.drafts.writeNativeChatDraftCache('tab-1:pane', '')

    expect(storage.drafts.size).toBe(0)
  })

  it('loses nothing past the old budget: 200 drafts and over 5M characters all come back', async () => {
    for (let index = 0; index < 200; index += 1) {
      modules.drafts.writeNativeChatDraftCache(`tab-${index}:pane`, `${index}`.padEnd(26_000, 'd'))
    }
    modules.store.flushNativeChatComposerDrafts()
    const returned = 'r'.repeat(MAX_PROMPT_BYTES)
    modules.drafts.appendNativeChatDraftCache('tab-0:pane', returned)

    const reloaded = await reload()
    for (let index = 0; index < 200; index += 1) {
      expect(reloaded.drafts.readNativeChatDraftCache(`tab-${index}:pane`)).toHaveLength(
        index === 0 ? 26_000 + 2 + returned.length : 26_000
      )
    }
    const total = [...storage.drafts.values()].reduce((sum, draft) => sum + draft.text.length, 0)
    expect(total).toBeGreaterThan(5_000_000)
  })

  it('shows a refused draft as not saved, retries it on the next flush, and clears that once it lands', async () => {
    modules.attachments.appendNativeChatAttachmentCache('tab-1:pane', IMAGES)
    modules.store.flushNativeChatComposerDrafts()
    await modules.store.nativeChatComposerDraftWritesSettled()
    const listener = vi.fn()
    modules.store.subscribeToNativeChatComposerDraft('tab-1:pane', listener)

    storage.refuseWrites = true
    modules.drafts.writeNativeChatDraftCache('tab-1:pane', 'refused')
    modules.store.flushNativeChatComposerDrafts()
    await modules.store.nativeChatComposerDraftWritesSettled()
    expect(modules.store.isNativeChatComposerDraftUnsaved('tab-1:pane')).toBe(true)
    expect(listener).toHaveBeenCalled()
    expect(modules.drafts.readNativeChatDraftCache('tab-1:pane')).toBe('refused')
    expect(storedDraft('tab-1:pane')?.text).toBe('')

    storage.refuseWrites = false
    // The next flush, here from the window hiding, retries it with no new change.
    window.dispatchEvent(new Event('pagehide'))
    await modules.store.nativeChatComposerDraftWritesSettled()
    expect(modules.store.isNativeChatComposerDraftUnsaved('tab-1:pane')).toBe(false)
    const reloaded = await reload()
    expect(reloaded.drafts.readNativeChatDraftCache('tab-1:pane')).toBe('refused')
    expect(reloaded.attachments.readNativeChatAttachmentCache('tab-1:pane')).toEqual(IMAGES)
  })

  it('shows an unsaved text without storing it, and stores it once the user changes it', async () => {
    modules.attachments.appendNativeChatAttachmentCache('tab-1:pane', IMAGES)
    modules.drafts.writeNativeChatDraftCache('tab-1:pane', 'https://example.com/issue/1', {
      unsaved: true
    })
    modules.drafts.writeNativeChatDraftDocument('tab-1:pane', 'https://example.com/issue/1', {
      type: 'doc'
    })
    modules.store.flushNativeChatComposerDrafts()

    expect(modules.drafts.readNativeChatDraftCache('tab-1:pane')).toBe(
      'https://example.com/issue/1'
    )
    expect(storedDraft('tab-1:pane')).toMatchObject({ text: '', images: IMAGES })
    modules.drafts.writeNativeChatDraftCache('tab-1:pane', 'https://example.com/issue/1 please')
    modules.store.flushNativeChatComposerDrafts()
    const reloaded = await reload()
    expect(reloaded.drafts.readNativeChatDraftCache('tab-1:pane')).toBe(
      'https://example.com/issue/1 please'
    )
  })

  it('writes nothing when a change leaves the draft as it was', () => {
    modules.drafts.writeNativeChatDraftCache('tab-1:pane', 'same')
    modules.store.flushNativeChatComposerDrafts()
    const write = vi.spyOn(storage, 'write')

    modules.drafts.writeNativeChatDraftCache('tab-1:pane', 'same')
    modules.store.updateNativeChatComposerDraft('tab-1:pane', { images: [] }, 'immediate')
    modules.store.flushNativeChatComposerDrafts()
    expect(write).not.toHaveBeenCalled()
  })

  it('drops a stored record that is not a draft', async () => {
    storage.drafts.set('broken', JSON.parse('{"text":5}'))
    storage.drafts.set('tab-1:pane', { text: 'fine', images: [], savedAt: 1 })

    const reloaded = await reload()
    await reloaded.store.nativeChatComposerDraftWritesSettled()
    expect(storage.drafts.has('broken')).toBe(false)
    expect(reloaded.drafts.readNativeChatDraftCache('tab-1:pane')).toBe('fine')
  })

  it('keeps what was typed before a slow load lands, and fills in the rest when it does', async () => {
    storage.drafts.set('tab-1:pane', { text: 'saved earlier', images: [], savedAt: 1 })
    storage.drafts.set('tab-2:pane', { text: 'other chat', images: [], savedAt: 1 })
    let land: () => void = () => {}
    const slow = {
      ...storage,
      loadAll: () =>
        new Promise<ReadonlyMap<string, unknown>>((resolve) => {
          land = () => resolve(new Map(storage.drafts))
        })
    }
    const reloaded = await reload({ using: slow, hydrate: false })
    // Startup gives up waiting; the load is still running.
    await reloaded.store.waitForNativeChatComposerDrafts(1)
    reloaded.drafts.writeNativeChatDraftCache('tab-1:pane', 'typed before the load')

    land()
    await reloaded.store.hydrateNativeChatComposerDrafts()
    expect(reloaded.drafts.readNativeChatDraftCache('tab-1:pane')).toBe('typed before the load')
    expect(reloaded.drafts.readNativeChatDraftCache('tab-2:pane')).toBe('other chat')
  })

  it('adds what is given back before a slow load lands to the saved draft, instead of replacing it', async () => {
    storage.drafts.set('agent-session:s1', {
      text: 'saved earlier',
      images: [IMAGES[0]],
      savedAt: 1
    })
    let land: () => void = () => {}
    // Storage reads as of the load's start, as IndexedDB does for a transaction begun first.
    const slow = {
      ...storage,
      loadAll: () => {
        const snapshot = new Map(storage.drafts)
        return new Promise<ReadonlyMap<string, unknown>>((resolve) => {
          land = () => resolve(snapshot)
        })
      }
    }
    const reloaded = await reload({ using: slow, hydrate: false })
    await reloaded.store.waitForNativeChatComposerDrafts(1)
    // Stop's restore, and a paste, before the load lands.
    reloaded.drafts.appendNativeChatDraftCache('agent-session:s1', 'returned by Stop')
    reloaded.attachments.appendNativeChatAttachmentCache('agent-session:s1', [IMAGES[1]], {
      fromUser: true
    })

    land()
    await reloaded.store.hydrateNativeChatComposerDrafts()
    await reloaded.store.nativeChatComposerDraftWritesSettled()
    expect(reloaded.drafts.readNativeChatDraftCache('agent-session:s1')).toBe(
      'saved earlier\n\nreturned by Stop'
    )
    expect(reloaded.attachments.readNativeChatAttachmentCache('agent-session:s1')).toEqual(IMAGES)
    expect(storedDraft('agent-session:s1')).toMatchObject({
      text: 'saved earlier\n\nreturned by Stop',
      images: IMAGES
    })
  })

  it('does not add an early append twice when the load already read its write', async () => {
    storage.drafts.set('agent-session:s1', { text: 'saved earlier', images: [], savedAt: 1 })
    let land: () => void = () => {}
    // This load reads only when it lands, after the append's own write.
    const late = {
      ...storage,
      loadAll: () =>
        new Promise<ReadonlyMap<string, unknown>>((resolve) => {
          land = () => resolve(new Map(storage.drafts))
        })
    }
    const reloaded = await reload({ using: late, hydrate: false })
    await reloaded.store.waitForNativeChatComposerDrafts(1)
    reloaded.drafts.appendNativeChatDraftCache('agent-session:s1', 'returned by Stop')

    land()
    await reloaded.store.hydrateNativeChatComposerDrafts()
    expect(reloaded.drafts.readNativeChatDraftCache('agent-session:s1')).toBe('returned by Stop')
  })

  it('retries a failed load a few times, warns once, and then stops', async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const broken = {
      ...storage,
      loadAll: vi.fn(() => Promise.reject(new Error('no backing store')))
    }
    const reloaded = await reload({ using: broken, hydrate: false })
    await reloaded.store.hydrateNativeChatComposerDrafts()
    for (let tick = 0; tick < 10; tick += 1) {
      reloaded.drafts.writeNativeChatDraftCache('tab-1:pane', `typing ${tick}`)
      await vi.advanceTimersByTimeAsync(60_000)
    }

    expect(broken.loadAll).toHaveBeenCalledTimes(4)
    expect(warn.mock.calls.filter(([message]) => String(message).includes('loaded'))).toHaveLength(
      1
    )
    expect(reloaded.drafts.readNativeChatDraftCache('tab-1:pane')).toBe('typing 9')
    warn.mockRestore()
  })

  it('does not echo a draft adopted from another window as a change of its own', async () => {
    const other = await reload()
    const doc = (text: string) => ({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text }] }]
    })
    other.drafts.writeNativeChatDraftDocument('agent-session:s3', 'abc', doc('abc'))
    other.store.flushNativeChatComposerDrafts()
    await vi.waitFor(() =>
      expect(modules.drafts.readNativeChatDraftCache('agent-session:s3')).toBe('abc')
    )
    // The editor here shows the adopted draft and hands back an equal document of its own.
    modules.drafts.writeNativeChatDraftDocument('agent-session:s3', 'abc', doc('abc'))
    other.drafts.writeNativeChatDraftDocument('agent-session:s3', 'abcd', doc('abcd'))
    other.store.flushNativeChatComposerDrafts()
    await other.store.nativeChatComposerDraftWritesSettled()
    await new Promise((resolve) => setTimeout(resolve, 20))
    modules.store.flushNativeChatComposerDrafts()
    await modules.store.nativeChatComposerDraftWritesSettled()
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(other.drafts.readNativeChatDraftCache('agent-session:s3')).toBe('abcd')
    expect(storedDraft('agent-session:s3')?.text).toBe('abcd')
  })

  it('never replays a closed window’s journal over a draft another window sent since', async () => {
    const tabB = modules
    // Tab A's write lands, but the page goes away before it is confirmed.
    const landsUnconfirmed = {
      ...storage,
      write: (scopeKey: string, draft: Parameters<typeof storage.write>[1]) => {
        storage.drafts.set(scopeKey, draft)
        return new Promise<void>(() => {})
      }
    }
    const tabA = await reload({ using: landsUnconfirmed })
    tabA.drafts.writeNativeChatDraftCache('agent-session:s1', 'typed in A, then A closed')
    window.dispatchEvent(new Event('pagehide'))
    expect(localStorage.getItem('orca:nativeChatComposerDraftJournal:v1')).toContain('typed in A')
    tabA.store.clearNativeChatComposerDraftsForTests()

    tabB.drafts.writeNativeChatDraftCache('agent-session:s1', 'written in B')
    tabB.store.clearNativeChatComposerDraftIfUnchanged('agent-session:s1', {
      text: 'written in B',
      images: []
    })
    await tabB.store.nativeChatComposerDraftWritesSettled()

    const tabC = await reload()
    expect(tabC.drafts.readNativeChatDraftCache('agent-session:s1')).toBe('')
    expect(localStorage.getItem('orca:nativeChatComposerDraftJournal:v1')).toBeNull()
  })

  it('keeps the journal small: never a refused draft, and never past its cap', async () => {
    storage.refuseWrites = true
    for (let index = 0; index < 10; index += 1) {
      modules.drafts.appendNativeChatDraftCache(
        `agent-session:refused-${index}`,
        'x'.repeat(200_000)
      )
    }
    await modules.store.nativeChatComposerDraftWritesSettled()
    window.dispatchEvent(new Event('pagehide'))
    expect(localStorage.getItem('orca:nativeChatComposerDraftJournal:v1')).toBeNull()

    storage.refuseWrites = false
    const hanging = { ...storage, write: () => new Promise<void>(() => {}) }
    const unconfirmedTab = await reload({ using: hanging })
    for (let index = 0; index < 10; index += 1) {
      unconfirmedTab.drafts.appendNativeChatDraftCache(
        `agent-session:big-${index}`,
        'y'.repeat(60_000)
      )
    }
    window.dispatchEvent(new Event('pagehide'))
    const journal = localStorage.getItem('orca:nativeChatComposerDraftJournal:v1') ?? ''
    expect(journal.length).toBeGreaterThan(0)
    expect(journal.length).toBeLessThanOrEqual(256_000)
  })

  it('keeps a restored image checked when another window saves the draft with the same image', async () => {
    const other = await reload()
    other.attachments.appendNativeChatAttachmentCache('tab-1:pane', [IMAGES[0]])
    await vi.waitFor(() =>
      expect(modules.attachments.readNativeChatAttachmentCache('tab-1:pane')).toEqual([IMAGES[0]])
    )
    modules.store.markNativeChatComposerDraftVerified('tab-1:pane')

    other.drafts.appendNativeChatDraftCache('tab-1:pane', 'caption')
    await vi.waitFor(() =>
      expect(modules.drafts.readNativeChatDraftCache('tab-1:pane')).toBe('caption')
    )
    expect(modules.store.isNativeChatComposerDraftUnverified('tab-1:pane')).toBe(false)

    other.attachments.appendNativeChatAttachmentCache('tab-1:pane', [IMAGES[1]])
    await vi.waitFor(() =>
      expect(modules.store.isNativeChatComposerDraftUnverified('tab-1:pane')).toBe(true)
    )
  })

  it('follows another window’s save of a draft, unless a change here is not saved yet', async () => {
    const other = await reload()
    other.drafts.appendNativeChatDraftCache('tab-1:pane', 'from the other tab')
    await vi.waitFor(() =>
      expect(modules.drafts.readNativeChatDraftCache('tab-1:pane')).toBe('from the other tab')
    )

    other.drafts.writeNativeChatDraftCache('tab-1:pane', '')
    await vi.waitFor(() => expect(modules.drafts.readNativeChatDraftCache('tab-1:pane')).toBe(''))

    vi.useFakeTimers()
    modules.drafts.writeNativeChatDraftCache('tab-1:pane', 'mine, not saved yet')
    other.drafts.appendNativeChatDraftCache('tab-1:pane', 'theirs')
    vi.useRealTimers()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(modules.drafts.readNativeChatDraftCache('tab-1:pane')).toBe('mine, not saved yet')
  })

  it('records the workspace a draft was written in, and deletes a closed chat’s draft with it', async () => {
    const owner = { workspaceId: 'repo::/wt', executionHostId: 'local' as const }
    modules.store.setNativeChatComposerDraftOwnerResolver((scopeKey) =>
      scopeKey === 'agent-session:closed' ? owner : undefined
    )
    modules.drafts.writeNativeChatDraftCache('agent-session:closed', 'unsent')
    modules.drafts.writeNativeChatDraftCache('agent-session:other', 'kept')
    modules.store.flushNativeChatComposerDrafts()
    expect(storedDraft('agent-session:closed')?.owner).toEqual(owner)

    const reloaded = await reload()
    reloaded.store.deleteNativeChatComposerDraftsOwnedBy({ ...owner, executionHostId: 'ssh:box' })
    expect(reloaded.drafts.readNativeChatDraftCache('agent-session:closed')).toBe('unsent')
    reloaded.store.deleteNativeChatComposerDraftsOwnedBy(owner)
    expect(reloaded.drafts.readNativeChatDraftCache('agent-session:closed')).toBe('')
    expect(storedDraft('agent-session:closed')).toBeNull()
    expect(storedDraft('agent-session:other')?.text).toBe('kept')
  })

  it('drops the drafts of a closed tab and leaves other tabs alone', async () => {
    modules.drafts.writeNativeChatDraftCache('tab-1:pane-a', 'a')
    modules.drafts.writeNativeChatDraftCache('tab-1:pane-b', 'b')
    modules.drafts.writeNativeChatDraftCache('tab-10:pane', 'other tab')
    modules.store.flushNativeChatComposerDrafts()
    modules.drafts.writeNativeChatDraftCache('tab-1:pane-a', 'a, still deferred')

    modules.store.deleteNativeChatComposerDraftsForTab('tab-1')
    expect(modules.drafts.readNativeChatDraftCache('tab-1:pane-a')).toBe('')
    modules.store.flushNativeChatComposerDrafts()
    const reloaded = await reload()
    expect(reloaded.drafts.readNativeChatDraftCache('tab-1:pane-a')).toBe('')
    expect(reloaded.drafts.readNativeChatDraftCache('tab-1:pane-b')).toBe('')
    expect(reloaded.drafts.readNativeChatDraftCache('tab-10:pane')).toBe('other tab')
  })

  it('keeps a conversation’s draft when a tab is closed, and drops it when deleted by its key', async () => {
    const conversation = modules.store.structuredAgentSessionDraftScopeKey('session-1')
    expect(conversation).toBe('agent-session:session-1')
    modules.drafts.writeNativeChatDraftCache(conversation, 'unsent')
    modules.drafts.writeNativeChatDraftCache('tab-1:pane', 'pane draft')
    modules.store.flushNativeChatComposerDrafts()
    // The prefix before the conversation key's ':' must never read as a tab id.
    modules.store.deleteNativeChatComposerDraftsForTab('agent-session')
    modules.store.deleteNativeChatComposerDraftsForTab('tab-1')
    expect(modules.drafts.readNativeChatDraftCache(conversation)).toBe('unsent')

    const listener = vi.fn()
    modules.store.subscribeToNativeChatComposerDraft(conversation, listener)
    modules.drafts.writeNativeChatDraftCache(conversation, 'unsent, still deferred')
    modules.store.deleteNativeChatComposerDraft(conversation)
    expect(listener).toHaveBeenCalled()
    expect(modules.drafts.readNativeChatDraftCache(conversation)).toBe('')
    modules.store.flushNativeChatComposerDrafts()
    const reloaded = await reload()
    expect(reloaded.drafts.readNativeChatDraftCache(conversation)).toBe('')
  })

  it('keeps the drafts of a tab whose id extends the closed one', async () => {
    // A second chat for one session gets `<tab id>:history-1`, so a prefix match would reach it.
    const closed = 'structured-agent-session-claude_1'
    const kept = `${closed}:history-1`
    modules.drafts.writeNativeChatDraftCache(`${closed}:0a1b2c3d-0000-4000-a000-000000000001`, 'a')
    modules.drafts.writeNativeChatDraftCache(`${kept}:0a1b2c3d-0000-4000-a000-000000000002`, 'b')
    modules.store.flushNativeChatComposerDrafts()

    modules.store.deleteNativeChatComposerDraftsForTab(closed)
    const reloaded = await reload()
    expect(
      reloaded.drafts.readNativeChatDraftCache(`${closed}:0a1b2c3d-0000-4000-a000-000000000001`)
    ).toBe('')
    expect(
      reloaded.drafts.readNativeChatDraftCache(`${kept}:0a1b2c3d-0000-4000-a000-000000000002`)
    ).toBe('b')
  })
})
