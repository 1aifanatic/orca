// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clearNativeChatDraftCacheForTests,
  readNativeChatDraftCache,
  writeNativeChatDraftCache
} from './native-chat-draft-cache'
import { structuredAgentSessionDraftScopeKey as scope } from './native-chat-composer-draft-store'
import {
  clearNativeChatComposerDraftForwardingForTests,
  currentNativeChatComposerDraftScope,
  forwardStructuredAgentSessionDraft
} from './native-chat-composer-draft-forwarding'
import {
  clearStructuredAgentSessionHandedBackNoticesForTests,
  noteStructuredAgentSessionHandedBackSend,
  useStructuredAgentSessionHandedBackNotice
} from './structured-agent-session-handed-back-notice'

afterEach(() => {
  clearNativeChatDraftCacheForTests()
  clearNativeChatComposerDraftForwardingForTests()
  clearStructuredAgentSessionHandedBackNoticesForTests()
})

describe('a draft when /clear replaces its conversation', () => {
  it('goes along to the new conversation, after anything already there', () => {
    writeNativeChatDraftCache(scope('old'), 'typed while the clear waited')
    writeNativeChatDraftCache(scope('new'), 'already here')
    forwardStructuredAgentSessionDraft('old', 'new')
    expect(readNativeChatDraftCache(scope('new'))).toBe(
      'already here\n\ntyped while the clear waited'
    )
    expect(readNativeChatDraftCache(scope('old'))).toBe('')
  })

  it('sends later hand-backs to the old conversation on to the new one, along a chain', () => {
    forwardStructuredAgentSessionDraft('old', 'new')
    forwardStructuredAgentSessionDraft('new', 'newer')
    expect(currentNativeChatComposerDraftScope(scope('old'))).toBe(scope('newer'))
    expect(currentNativeChatComposerDraftScope(scope('other'))).toBe(scope('other'))
  })

  it('moving the same way again adds nothing twice', () => {
    writeNativeChatDraftCache(scope('old'), 'once')
    forwardStructuredAgentSessionDraft('old', 'new')
    forwardStructuredAgentSessionDraft('old', 'new')
    expect(readNativeChatDraftCache(scope('new'))).toBe('once')
  })
})

describe('why a send came back, said once where its text is', () => {
  it('waits for the composer that holds the text, then shows it once', () => {
    forwardStructuredAgentSessionDraft('old', 'new')
    noteStructuredAgentSessionHandedBackSend(scope('old'), 'The chat was cleared.')
    const show = vi.fn()
    const { unmount } = renderHook(() =>
      useStructuredAgentSessionHandedBackNotice(scope('new'), show)
    )
    expect(show).toHaveBeenCalledExactlyOnceWith('The chat was cleared.')
    unmount()
    const again = vi.fn()
    renderHook(() => useStructuredAgentSessionHandedBackNotice(scope('new'), again))
    expect(again).not.toHaveBeenCalled()
  })

  it('reaches a composer already showing', () => {
    const show = vi.fn()
    renderHook(() => useStructuredAgentSessionHandedBackNotice(scope('new'), show))
    act(() => noteStructuredAgentSessionHandedBackSend(scope('new'), 'back'))
    expect(show).toHaveBeenCalledExactlyOnceWith('back')
  })
})
