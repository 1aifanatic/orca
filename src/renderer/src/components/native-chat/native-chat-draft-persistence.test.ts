// A half-typed chat message survives quitting Orca. Typing is saved after a pause; the clear at
// send and any text put back are saved at once, so a crash right after Enter cannot bring back
// text the host already took.

// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NATIVE_CHAT_COMPOSER_SCOPE_CACHE_MAX } from './native-chat-composer-scope-cache'
import type * as NativeChatDraftCache from './native-chat-draft-cache'

const PREFIX = 'orca:nativeChatComposerDraft:v1:'
const SCOPE = 'structured-agent-session-s1:pane'

type DraftCache = typeof NativeChatDraftCache

/** A fresh renderer: module memory is gone, only localStorage remains. */
async function relaunch(): Promise<DraftCache> {
  vi.resetModules()
  return import('./native-chat-draft-cache')
}

function saved(scopeKey: string): { text: string; attachments: unknown[] } | null {
  const raw = localStorage.getItem(`${PREFIX}${encodeURIComponent(scopeKey)}`)
  return raw ? JSON.parse(raw) : null
}

let cache: DraftCache

beforeEach(async () => {
  vi.useFakeTimers()
  localStorage.clear()
  cache = await relaunch()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  cache.clearNativeChatDraftCacheForTests()
  vi.useRealTimers()
})

/** Storage that reads fine but refuses every write, as a full quota does. */
function fullStorage(): Storage {
  const real = localStorage
  return {
    get length() {
      return real.length
    },
    key: (index) => real.key(index),
    getItem: (key) => real.getItem(key),
    clear: () => real.clear(),
    removeItem: () => {
      throw new DOMException('quota', 'QuotaExceededError')
    },
    setItem: () => {
      throw new DOMException('quota', 'QuotaExceededError')
    }
  }
}

describe('composer draft persistence', () => {
  it('restores typed text and attachments after a relaunch', async () => {
    cache.writeNativeChatDraftCache(SCOPE, 'half typed')
    cache.writeNativeChatDraftAttachments(SCOPE, [
      { id: 'a1', path: '/tmp/shot.png', connectionId: 'ssh-1' }
    ])
    vi.advanceTimersByTime(300)

    const next = await relaunch()

    expect(next.readNativeChatDraftCache(SCOPE)).toBe('half typed')
    expect(next.readNativeChatDraftAttachments(SCOPE)).toEqual([
      { id: 'a1', path: '/tmp/shot.png', connectionId: 'ssh-1' }
    ])
  })

  it('saves typing only after the pause', () => {
    cache.writeNativeChatDraftCache(SCOPE, 'h')
    cache.writeNativeChatDraftCache(SCOPE, 'he')
    expect(saved(SCOPE)).toBeNull()

    vi.advanceTimersByTime(299)
    expect(saved(SCOPE)).toBeNull()
    vi.advanceTimersByTime(1)
    expect(saved(SCOPE)?.text).toBe('he')
  })

  it.each([
    ['pagehide', () => window.dispatchEvent(new Event('pagehide'))],
    [
      'the page becoming hidden',
      () => {
        vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
        document.dispatchEvent(new Event('visibilitychange'))
      }
    ]
  ])('flushes pending typing on %s', (_case, hide) => {
    cache.writeNativeChatDraftCache(SCOPE, 'about to quit')
    expect(saved(SCOPE)).toBeNull()

    hide()

    expect(saved(SCOPE)?.text).toBe('about to quit')
  })

  it('writes the clear at send at once, cancelling the pending typing write', async () => {
    cache.writeNativeChatDraftCache(SCOPE, 'sent text')
    vi.advanceTimersByTime(300)
    cache.writeNativeChatDraftCache(SCOPE, 'sent text, edited')

    // Enter: the composer clears; a crash follows before any timer runs.
    cache.writeNativeChatDraftCache(SCOPE, '')

    expect(saved(SCOPE)).toBeNull()
    const next = await relaunch()
    expect(next.readNativeChatDraftCache(SCOPE)).toBe('')
  })

  it('writes text put back at once and reports that it reached disk', async () => {
    const result = cache.appendNativeChatDraftNow(SCOPE, {
      text: 'withdrawn',
      attachments: [{ id: 'w1', path: '/tmp/w.png' }]
    })

    expect(result).toBe('persisted')
    expect(saved(SCOPE)).toMatchObject({
      text: 'withdrawn',
      attachments: [{ id: 'w1', path: '/tmp/w.png' }]
    })
    const next = await relaunch()
    expect(next.readNativeChatDraftCache(SCOPE)).toBe('withdrawn')
  })

  it('restores only into an empty composer', () => {
    cache.writeNativeChatDraftCache(SCOPE, 'typed since')

    expect(cache.restoreNativeChatDraftIfEmpty(SCOPE, { text: 'refused' })).toBe(
      'composer-not-empty'
    )
    expect(cache.readNativeChatDraftCache(SCOPE)).toBe('typed since')

    cache.writeNativeChatDraftCache(SCOPE, '')
    expect(cache.restoreNativeChatDraftIfEmpty(SCOPE, { text: 'refused' })).toBe('persisted')
    expect(saved(SCOPE)?.text).toBe('refused')
  })

  it('keeps drafts for every chat apart', async () => {
    cache.appendNativeChatDraftNow('chat-a', { text: 'for a' })
    cache.appendNativeChatDraftNow('chat-b', { text: 'for b' })

    const next = await relaunch()

    expect(next.readNativeChatDraftCache('chat-a')).toBe('for a')
    expect(next.readNativeChatDraftCache('chat-b')).toBe('for b')
  })

  it('names a structured chat by its session, whichever pane shows it', async () => {
    const before = cache.nativeChatDraftKey({ sessionId: 's1', paneKey: 'tab-1:leaf-1' })
    cache.appendNativeChatDraftNow(before, { text: 'follows the chat' })

    const next = await relaunch()
    const after = next.nativeChatDraftKey({ sessionId: 's1', paneKey: 'tab-9:leaf-9' })

    expect(next.readNativeChatDraftCache(after)).toBe('follows the chat')
    expect(next.nativeChatDraftKey({ paneKey: 'tab-1:leaf-1' })).not.toBe(before)
  })

  it('keeps the draft in memory and reports memory-only when storage throws', () => {
    vi.stubGlobal('localStorage', fullStorage())

    expect(() => cache.writeNativeChatDraftCache(SCOPE, 'typed')).not.toThrow()
    expect(() => vi.advanceTimersByTime(300)).not.toThrow()
    expect(cache.appendNativeChatDraftNow(SCOPE, { text: 'back' })).toBe('memory-only')
    expect(cache.readNativeChatDraftCache(SCOPE)).toBe('typed\n\nback')
  })

  it('works without storage at all', async () => {
    vi.stubGlobal('localStorage', undefined)
    const next = await relaunch()

    next.writeNativeChatDraftCache(SCOPE, 'typed')
    expect(next.appendNativeChatDraftNow(SCOPE, { text: 'back' })).toBe('memory-only')
    expect(next.readNativeChatDraftCache(SCOPE)).toBe('typed\n\nback')
  })

  it('bounds the saved drafts, dropping the least recently written', async () => {
    const total = NATIVE_CHAT_COMPOSER_SCOPE_CACHE_MAX + 5
    for (let index = 0; index < total; index += 1) {
      vi.setSystemTime(1_000 + index)
      cache.appendNativeChatDraftNow(`scope-${index}`, { text: `draft-${index}` })
    }

    expect(saved('scope-0')).toBeNull()
    expect(saved(`scope-${total - 1}`)?.text).toBe(`draft-${total - 1}`)
    const next = await relaunch()
    expect(next.readNativeChatDraftCache('scope-4')).toBe('')
    expect(next.readNativeChatDraftCache('scope-5')).toBe('draft-5')
  })

  it('prunes saved drafts past the bound when they load', async () => {
    const total = NATIVE_CHAT_COMPOSER_SCOPE_CACHE_MAX + 3
    for (let index = 0; index < total; index += 1) {
      localStorage.setItem(
        `${PREFIX}scope-${index}`,
        JSON.stringify({ text: `draft-${index}`, attachments: [], savedAt: index })
      )
    }
    localStorage.setItem(`${PREFIX}broken`, '{not json')

    const next = await relaunch()

    expect(next.readNativeChatDraftCache('scope-2')).toBe('')
    expect(next.readNativeChatDraftCache('scope-3')).toBe('draft-3')
    expect(saved('scope-0')).toBeNull()
    expect(localStorage.getItem(`${PREFIX}broken`)).toBeNull()
  })
})
