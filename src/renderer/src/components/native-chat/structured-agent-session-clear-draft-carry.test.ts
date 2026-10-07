import { afterEach, expect, it } from 'vitest'
import {
  carryClearedNativeChatDraftScope,
  carryClearedStructuredAgentSessionDraft,
  noteStructuredAgentSessionClearedInto,
  resetStructuredAgentSessionClearCarryForTests
} from './structured-agent-session-clear-draft-carry'
import {
  clearNativeChatComposerDraftsForTests,
  readNativeChatComposerDraft,
  structuredAgentSessionDraftScopeKey,
  updateNativeChatComposerDraft
} from './native-chat-composer-draft-store'

const scope = structuredAgentSessionDraftScopeKey

afterEach(() => {
  resetStructuredAgentSessionClearCarryForTests()
  clearNativeChatComposerDraftsForTests()
})

it('moves a cleared conversation draft, text and images, after what the new one holds', () => {
  noteStructuredAgentSessionClearedInto('session-a', 'session-b')
  updateNativeChatComposerDraft(
    scope('session-a'),
    {
      text: 'typed during clear',
      images: [{ id: 'i1', path: '/remote/a.png', connectionId: 'ssh-1' }]
    },
    'immediate'
  )
  updateNativeChatComposerDraft(scope('session-b'), { text: 'already here' }, 'immediate')

  // The composer's side, once its /clear settled: the chat may still show the old conversation.
  carryClearedNativeChatDraftScope(scope('session-a'))

  expect(readNativeChatComposerDraft(scope('session-b'))).toMatchObject({
    text: 'already here\n\ntyped during clear',
    images: [{ id: 'i1', path: '/remote/a.png', connectionId: 'ssh-1' }]
  })
  expect(readNativeChatComposerDraft(scope('session-a')).text).toBe('')

  // Typed in the old box before the chat moved: it follows when the view leaves.
  updateNativeChatComposerDraft(scope('session-a'), { text: 'one more' }, 'immediate')
  carryClearedStructuredAgentSessionDraft('session-a', { leaving: true })
  expect(readNativeChatComposerDraft(scope('session-b')).text).toContain('one more')

  // Leaving consumed it: a later draft in that conversation stays there.
  updateNativeChatComposerDraft(scope('session-a'), { text: 'reopened' }, 'immediate')
  carryClearedStructuredAgentSessionDraft('session-a', { leaving: true })
  expect(readNativeChatComposerDraft(scope('session-a')).text).toBe('reopened')
})

it('moves nothing for a conversation no /clear here moved', () => {
  updateNativeChatComposerDraft(scope('session-c'), { text: 'mine' }, 'immediate')
  carryClearedNativeChatDraftScope(scope('session-c'))
  carryClearedStructuredAgentSessionDraft('session-c', { leaving: true })
  expect(readNativeChatComposerDraft(scope('session-c')).text).toBe('mine')
})
