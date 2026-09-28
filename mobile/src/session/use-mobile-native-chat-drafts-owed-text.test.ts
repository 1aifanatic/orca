// Withdrawn queued text answered while the session screen was closed is owed to
// its pane and lands in that pane's composer exactly once, when that pane is next
// active — never in another pane's composer.

import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  oweComposerText,
  resetOwedComposerTextForTests
} from './mobile-native-chat-owed-composer-text'
import { mobileNativeChatScopeKey } from './mobile-native-chat-scope-key'
import { useMobileNativeChatDrafts } from './use-mobile-native-chat-drafts'

const PANE_A = mobileNativeChatScopeKey('host', 'worktree', 'a')!
const PANE_B = mobileNativeChatScopeKey('host', 'worktree', 'b')!

describe('useMobileNativeChatDrafts owed queued text', () => {
  let renderer: ReactTestRenderer | null = null
  let state: ReturnType<typeof useMobileNativeChatDrafts> | null = null

  beforeEach(() => {
    resetOwedComposerTextForTests()
  })

  afterEach(() => {
    unmount()
  })

  function Harness({ tabId }: { tabId: string }): null {
    state = useMobileNativeChatDrafts({
      hostId: 'host',
      worktreeId: 'worktree',
      tabId,
      sessionId: `session-${tabId}`,
      messages: [],
      launchDraft: null,
      transcriptLoading: false,
      transcriptSettled: true
    })
    return null
  }

  function render(tabId: string): void {
    act(() => {
      if (renderer) {
        renderer.update(createElement(Harness, { tabId }))
      } else {
        renderer = create(createElement(Harness, { tabId }))
      }
    })
  }

  function unmount(): void {
    act(() => renderer?.unmount())
    renderer = null
    state = null
  }

  it('lands text answered while the screen was closed, once, when it reopens', () => {
    render('a')
    unmount()
    oweComposerText(PANE_A, 'withdrawn while away')
    render('a')
    expect(state?.composerText).toBe('withdrawn while away')
    unmount()
    render('a')
    // A fresh composer (the old one died with the screen) is not handed it again.
    expect(state?.composerText).toBe('')
  })

  it('appends after newer typing while the pane is open', () => {
    render('a')
    act(() => state?.setComposerText('typed since'))
    act(() => oweComposerText(PANE_A, 'restored'))
    expect(state?.composerText).toBe('typed since\nrestored')
  })

  it("holds another pane's text until that pane is active", () => {
    render('a')
    act(() => oweComposerText(PANE_B, 'for b'))
    expect(state?.composerText).toBe('')
    render('b')
    expect(state?.composerText).toBe('for b')
    render('a')
    expect(state?.composerText).toBe('')
  })
})
