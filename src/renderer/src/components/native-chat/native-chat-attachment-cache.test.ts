import { afterEach, describe, expect, it } from 'vitest'
import {
  appendNativeChatAttachmentCache,
  clearNativeChatAttachmentCacheForTests,
  readNativeChatAttachmentCache,
  resolveNativeChatPendingAttachment,
  subscribeToNativeChatAttachmentCache,
  updateNativeChatAttachmentCache
} from './native-chat-attachment-cache'
import { NATIVE_CHAT_COMPOSER_SCOPE_CACHE_MAX } from './native-chat-composer-scope-cache'

afterEach(() => clearNativeChatAttachmentCacheForTests())

function fillWithOtherScopes(): void {
  for (let index = 0; index <= NATIVE_CHAT_COMPOSER_SCOPE_CACHE_MAX; index += 1) {
    appendNativeChatAttachmentCache(`other-${index}`, [
      { id: `o${index}`, path: `/tmp/${index}.png` }
    ])
  }
}

describe('the pane attachment cache bound', () => {
  it('never evicts a scope a composer is showing, however many newer scopes arrive', () => {
    appendNativeChatAttachmentCache('pane-a', [{ id: 'a1', path: '/tmp/a.png' }])
    const unsubscribe = subscribeToNativeChatAttachmentCache('pane-a', () => {})

    fillWithOtherScopes()

    expect(readNativeChatAttachmentCache('pane-a')).toEqual([{ id: 'a1', path: '/tmp/a.png' }])
    // The bound still holds: the oldest scope nobody shows went instead.
    expect(readNativeChatAttachmentCache('other-0')).toEqual([])
    unsubscribe()
  })

  it('never evicts a scope whose attachment is still on its way, so it can still settle', () => {
    updateNativeChatAttachmentCache('pane-b', () => [{ id: 'b1', path: '', pending: true }])

    fillWithOtherScopes()

    expect(resolveNativeChatPendingAttachment('pane-b', 'b1', '/srv/b.png')).toBe(true)
    expect(readNativeChatAttachmentCache('pane-b')).toEqual([{ id: 'b1', path: '/srv/b.png' }])
  })

  it('evicts the oldest scope nobody uses', () => {
    appendNativeChatAttachmentCache('pane-c', [{ id: 'c1', path: '/tmp/c.png' }])
    fillWithOtherScopes()
    expect(readNativeChatAttachmentCache('pane-c')).toEqual([])
  })

  it('keeps a write to an unused scope when every older scope is in use', () => {
    const unsubscribes = Array.from(
      { length: NATIVE_CHAT_COMPOSER_SCOPE_CACHE_MAX },
      (_, index) => {
        appendNativeChatAttachmentCache(`shown-${index}`, [
          { id: `s${index}`, path: `/tmp/${index}.png` }
        ])
        return subscribeToNativeChatAttachmentCache(`shown-${index}`, () => {})
      }
    )

    appendNativeChatAttachmentCache('pane-d', [{ id: 'd1', path: '/tmp/d.png' }])

    expect(readNativeChatAttachmentCache('pane-d')).toEqual([{ id: 'd1', path: '/tmp/d.png' }])
    expect(readNativeChatAttachmentCache('shown-0')).toHaveLength(1)
    unsubscribes.forEach((unsubscribe) => unsubscribe())
  })
})
