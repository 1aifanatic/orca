import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it } from 'vitest'
import { useMobileNativeChatDrafts } from './use-mobile-native-chat-drafts'
import { mobileReplacedSessionToFollow } from './use-mobile-native-chat-draft-follow'

type DraftState = ReturnType<typeof useMobileNativeChatDrafts>

describe('a draft when /clear replaces its conversation', () => {
  let renderer: ReactTestRenderer | null = null
  let state: DraftState | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    state = null
  })

  /** `open`: the sessions the phone's tab list shows, when a test names them. */
  type Tab = { tabId: string; sessionId: string; replacesSessionId?: string; open?: string[] }

  function Harness({ tabId, sessionId, replacesSessionId, open }: Tab): null {
    state = useMobileNativeChatDrafts({
      hostId: 'host',
      worktreeId: 'worktree',
      tabId,
      sessionId,
      replacesSessionId: mobileReplacedSessionToFollow(
        replacesSessionId ? { type: 'agent-session', replacesSessionId } : null,
        (open ?? []).map((id) => ({ type: 'agent-session', sessionId: id }))
      ),
      messages: [],
      transcriptSettled: true
    })
    return null
  }

  async function show(tab: Tab): Promise<void> {
    await act(async () => {
      if (renderer) {
        renderer.update(createElement(Harness, tab))
      } else {
        renderer = create(createElement(Harness, tab))
      }
    })
  }

  const OLD = { tabId: 'agent-session:old', sessionId: 'old' }
  const NEW = { tabId: 'agent-session:new', sessionId: 'new', replacesSessionId: 'old' }

  it('goes to the tab that replaced it, and the old tab keeps nothing', async () => {
    await show(OLD)
    act(() => state?.setComposerText('typed while the clear waited'))
    await show(NEW)
    expect(state?.composerText).toBe('typed while the clear waited')
    await show({ tabId: OLD.tabId, sessionId: OLD.sessionId })
    expect(state?.composerText).toBe('')
  })

  it('stays in a cleared chat reopened beside the new one until its tab closes', async () => {
    const reopened = { ...OLD, tabId: 'agent-session:old-reopened', open: ['old', 'new'] }
    await show(reopened)
    act(() => state?.setComposerText('typed in the reopened chat'))
    await show({ ...NEW, open: ['old', 'new'] })
    expect(state?.composerText).toBe('')
    await show(reopened)
    expect(state?.composerText).toBe('typed in the reopened chat')
    // Its tab closed: what it held follows the new chat, once.
    await show({ ...NEW, open: ['new'] })
    expect(state?.composerText).toBe('typed in the reopened chat')
  })

  it('goes after a draft the new tab already holds, never over it', async () => {
    await show(NEW)
    act(() => state?.setComposerText('already in the new chat'))
    await show(OLD)
    act(() => state?.setComposerText('typed in the old one'))
    await show(NEW)
    expect(state?.composerText).toBe('already in the new chat\n\ntyped in the old one')
  })

  it('takes text a send hands back after the move', async () => {
    await show(OLD)
    act(() => state?.setComposerText('raced the clear'))
    const origin = state?.captureSendOrigin('raced the clear')
    act(() => {
      if (origin) {
        state?.clearDraftForSend(origin, 'raced the clear')
      }
    })
    await show(NEW)
    act(() => {
      if (origin) {
        state?.restoreRejectedDraft(origin, 'raced the clear')
      }
    })
    expect(state?.composerText).toBe('raced the clear')
  })

  it('comes along even when another tab was showing while the clear ran', async () => {
    await show(OLD)
    act(() => state?.setComposerText('typed before switching away'))
    await show({ tabId: 'agent-session:other', sessionId: 'other' })
    await show(NEW)
    expect(state?.composerText).toBe('typed before switching away')
  })

  it('takes text handed back to the old tab while another tab showed', async () => {
    await show(OLD)
    const origin = state?.captureSendOrigin('raced the clear')
    await show({ tabId: 'agent-session:other', sessionId: 'other' })
    act(() => {
      if (origin) {
        state?.restoreRejectedDraft(origin, 'raced the clear')
      }
    })
    await show(NEW)
    expect(state?.composerText).toBe('raced the clear')
  })

  it('never carries the lone /clear itself', async () => {
    await show(OLD)
    act(() => state?.setComposerText('/clear'))
    await show(NEW)
    expect(state?.composerText).toBe('')
  })

  it('a tab switch to another chat moves nothing', async () => {
    await show(OLD)
    act(() => state?.setComposerText('stays here'))
    await show({ tabId: 'agent-session:other', sessionId: 'other' })
    expect(state?.composerText).toBe('')
    await show(OLD)
    expect(state?.composerText).toBe('stays here')
  })
})
