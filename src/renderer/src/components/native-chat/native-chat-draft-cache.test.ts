import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  appendNativeChatDraftCache,
  appendNativeChatDraftText,
  clearNativeChatDraftCacheForTests,
  readNativeChatDraftCache,
  returnNativeChatDraftText,
  subscribeToNativeChatDraftAppend,
  writeNativeChatDraftCache
} from './native-chat-draft-cache'
import { NATIVE_CHAT_COMPOSER_SCOPE_CACHE_MAX } from './native-chat-composer-scope-cache'

afterEach(() => {
  clearNativeChatDraftCacheForTests()
})

describe('native-chat draft cache', () => {
  it('returns an empty string for an unknown scope', () => {
    expect(readNativeChatDraftCache('pty-1')).toBe('')
  })

  it('round-trips a draft per scope key', () => {
    writeNativeChatDraftCache('pty-1', 'hello')
    writeNativeChatDraftCache('pty-2', 'world')
    expect(readNativeChatDraftCache('pty-1')).toBe('hello')
    expect(readNativeChatDraftCache('pty-2')).toBe('world')
  })

  it('drops the entry when the draft is cleared so stale text never resurfaces', () => {
    writeNativeChatDraftCache('pty-1', 'hello')
    writeNativeChatDraftCache('pty-1', '')
    expect(readNativeChatDraftCache('pty-1')).toBe('')
  })

  it('bounds the cache so unsent drafts for removed panes cannot accumulate', () => {
    writeNativeChatDraftCache('keep', 'hot')

    const total = NATIVE_CHAT_COMPOSER_SCOPE_CACHE_MAX + 40
    for (let i = 0; i < total; i += 1) {
      writeNativeChatDraftCache(`scope-${i}`, `draft-${i}`)
      if (i % 20 === 0) {
        writeNativeChatDraftCache('keep', 'hot')
      }
    }

    // Oldest untouched draft evicted; the actively-edited and most-recent survive.
    expect(readNativeChatDraftCache('scope-0')).toBe('')
    expect(readNativeChatDraftCache('keep')).toBe('hot')
    expect(readNativeChatDraftCache(`scope-${total - 1}`)).toBe(`draft-${total - 1}`)
  })

  it('appends after a blank line, treating a whitespace-only draft as empty', () => {
    expect(appendNativeChatDraftText('typed  \n', 'given back')).toBe('typed\n\ngiven back')
    expect(appendNativeChatDraftText('', 'given back')).toBe('given back')
    expect(appendNativeChatDraftText(' \n\t', 'given back')).toBe('given back')
    writeNativeChatDraftCache('pane', '  ')
    appendNativeChatDraftCache('pane', 'given back')
    expect(readNativeChatDraftCache('pane')).toBe('given back')
  })
})

describe('returnNativeChatDraftText', () => {
  it('appends returned text after a blank line, with no composer mounted', () => {
    writeNativeChatDraftCache('agent-session:s1', 'typed meanwhile')
    returnNativeChatDraftText('agent-session:s1', 'unsent message')
    expect(readNativeChatDraftCache('agent-session:s1')).toBe('typed meanwhile\n\nunsent message')
  })

  it('is idempotent: text the draft already holds is not added again', () => {
    returnNativeChatDraftText('agent-session:s1', 'unsent message')
    returnNativeChatDraftText('agent-session:s1', 'unsent message')
    writeNativeChatDraftCache('agent-session:s1', 'before\n\nunsent message\n\nafter')
    returnNativeChatDraftText('agent-session:s1', '\nunsent message  ')
    expect(readNativeChatDraftCache('agent-session:s1')).toBe('before\n\nunsent message\n\nafter')
  })

  it('puts no blank lines before text returned to a whitespace-only draft', () => {
    writeNativeChatDraftCache('agent-session:s1', ' \n ')
    returnNativeChatDraftText('agent-session:s1', 'unsent message')
    expect(readNativeChatDraftCache('agent-session:s1')).toBe('unsent message')
  })

  it('ignores blank text', () => {
    returnNativeChatDraftText('agent-session:s1', ' \n')
    expect(readNativeChatDraftCache('agent-session:s1')).toBe('')
  })

  it('tells a composer mid-composition only when it actually appends', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeToNativeChatDraftAppend('agent-session:s1', listener)
    returnNativeChatDraftText('agent-session:s1', 'unsent message')
    returnNativeChatDraftText('agent-session:s1', 'unsent message')
    unsubscribe()
    expect(listener).toHaveBeenCalledExactlyOnceWith('unsent message', '')
  })
})
