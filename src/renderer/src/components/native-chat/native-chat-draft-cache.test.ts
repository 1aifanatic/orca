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
import { appendNativeChatAttachmentCache } from './native-chat-draft-images'
import { readNativeChatAttachmentCache } from './use-native-chat-composer-attachments'

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

  it('keeps every draft however many there are, since a draft that is pushed out is lost', () => {
    const total = NATIVE_CHAT_COMPOSER_SCOPE_CACHE_MAX + 40
    for (let i = 0; i < total; i += 1) {
      writeNativeChatDraftCache(`scope-${i}`, `draft-${i}`)
    }

    expect(readNativeChatDraftCache('scope-0')).toBe('draft-0')
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

  it('is idempotent: text the draft already ends with is not added again', () => {
    returnNativeChatDraftText('agent-session:s1', 'unsent message')
    returnNativeChatDraftText('agent-session:s1', 'unsent message')
    expect(readNativeChatDraftCache('agent-session:s1')).toBe('unsent message')
    writeNativeChatDraftCache('agent-session:s1', 'before\n\nunsent message  \n')
    returnNativeChatDraftText('agent-session:s1', 'unsent message  ')
    expect(readNativeChatDraftCache('agent-session:s1')).toBe('before\n\nunsent message  \n')
  })

  it('still returns text that only appears inside a longer draft', () => {
    writeNativeChatDraftCache('agent-session:s1', 'use the other algorithm and go')
    returnNativeChatDraftText('agent-session:s1', 'go')
    expect(readNativeChatDraftCache('agent-session:s1')).toBe(
      'use the other algorithm and go\n\ngo'
    )
    writeNativeChatDraftCache('agent-session:s1', 'yes\n\nthen run the tests')
    returnNativeChatDraftText('agent-session:s1', 'yes')
    expect(readNativeChatDraftCache('agent-session:s1')).toBe('yes\n\nthen run the tests\n\nyes')
  })

  it("keeps the returned text's leading indentation", () => {
    returnNativeChatDraftText('agent-session:s1', '    indented code\n')
    expect(readNativeChatDraftCache('agent-session:s1')).toBe('    indented code')
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

  it('adds an image given back again only once, keeping its SSH connection', () => {
    const image = { id: 'withdrawn-m1-0', path: '/repo/shot.png', connectionId: 'ssh-1' }
    appendNativeChatAttachmentCache('agent-session:s1', [image])
    appendNativeChatAttachmentCache('agent-session:s1', [
      image,
      { id: 'withdrawn-m1-1', path: '/repo/other.png' }
    ])
    expect(readNativeChatAttachmentCache('agent-session:s1')).toEqual([
      image,
      { id: 'withdrawn-m1-1', path: '/repo/other.png' }
    ])
  })
})
