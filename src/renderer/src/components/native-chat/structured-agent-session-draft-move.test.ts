// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Tab } from '../../../../shared/tab-types'
import {
  moveStructuredAgentSessionDraft,
  noteNativeChatDraftSendOut,
  resetStructuredAgentSessionDraftMoveForTests,
  structuredAgentSessionConversationMoves
} from './structured-agent-session-draft-move'
import {
  clearNativeChatComposerDraftsForTests,
  hydrateNativeChatComposerDrafts,
  readNativeChatComposerDraft,
  structuredAgentSessionDraftScopeKey,
  updateNativeChatComposerDraft
} from './native-chat-composer-draft-store'
import {
  createMemoryNativeChatComposerDraftStorage,
  setNativeChatComposerDraftStorageForTests
} from './native-chat-composer-draft-storage'

const scope = structuredAgentSessionDraftScopeKey
const SSH_IMAGE = { id: 'i1', path: '/remote/shot.png', connectionId: 'ssh-1' }

beforeEach(async () => {
  setNativeChatComposerDraftStorageForTests(createMemoryNativeChatComposerDraftStorage())
  await hydrateNativeChatComposerDrafts()
})

afterEach(() => {
  resetStructuredAgentSessionDraftMoveForTests()
  clearNativeChatComposerDraftsForTests()
})

describe('moving a cleared conversation draft', () => {
  it('moves text, SSH images and skill chips whole into the new conversation', () => {
    const document = { type: 'doc', content: [{ type: 'paragraph' }] }
    updateNativeChatComposerDraft(
      scope('a'),
      { text: 'typed during clear', document, images: [SSH_IMAGE] },
      'immediate'
    )

    moveStructuredAgentSessionDraft('a', 'b')

    expect(readNativeChatComposerDraft(scope('b'))).toMatchObject({
      text: 'typed during clear',
      document,
      images: [SSH_IMAGE]
    })
    expect(readNativeChatComposerDraft(scope('a'))).toMatchObject({ text: '', images: [] })
  })

  it('goes after what the new conversation already holds', () => {
    updateNativeChatComposerDraft(scope('a'), { text: 'moved' }, 'immediate')
    updateNativeChatComposerDraft(scope('b'), { text: 'already here' }, 'immediate')

    moveStructuredAgentSessionDraft('a', 'b')

    expect(readNativeChatComposerDraft(scope('b')).text).toBe('already here\n\nmoved')
  })

  it("leaves a send's own text behind for it to clear, and moves what was typed after it", () => {
    updateNativeChatComposerDraft(scope('a'), { text: '/clear' }, 'immediate')
    const settled = noteNativeChatDraftSendOut(scope('a'), readNativeChatComposerDraft(scope('a')))
    updateNativeChatComposerDraft(
      scope('a'),
      { text: '/clear\nnext question', images: [SSH_IMAGE] },
      'immediate'
    )

    moveStructuredAgentSessionDraft('a', 'b')

    expect(readNativeChatComposerDraft(scope('b'))).toMatchObject({
      text: '\nnext question',
      images: [SSH_IMAGE]
    })
    expect(readNativeChatComposerDraft(scope('a'))).toMatchObject({ text: '/clear', images: [] })
    settled()
    updateNativeChatComposerDraft(scope('a'), { text: '/clear more' }, 'immediate')
    moveStructuredAgentSessionDraft('a', 'b')
    expect(readNativeChatComposerDraft(scope('b')).text).toBe('\nnext question\n\n/clear more')
  })

  it('moves nothing from an empty draft', () => {
    updateNativeChatComposerDraft(scope('b'), { text: 'mine' }, 'immediate')
    moveStructuredAgentSessionDraft('a', 'b')
    expect(readNativeChatComposerDraft(scope('b')).text).toBe('mine')
  })

  it('waits for the saved drafts to load before moving one only storage holds', async () => {
    clearNativeChatComposerDraftsForTests()
    const storage = createMemoryNativeChatComposerDraftStorage()
    storage.drafts.set(scope('a'), { text: 'saved before quit', images: [], savedAt: 1 })
    setNativeChatComposerDraftStorageForTests(storage)
    const loading = hydrateNativeChatComposerDrafts()

    moveStructuredAgentSessionDraft('a', 'b')
    await loading
    await Promise.resolve()

    expect(readNativeChatComposerDraft(scope('b')).text).toBe('saved before quit')
    expect(readNativeChatComposerDraft(scope('a')).text).toBe('')
  })
})

function chat(id: string, entityId: string, contentType: Tab['contentType'] = 'agent-session') {
  return {
    id,
    entityId,
    contentType,
    groupId: 'g',
    worktreeId: 'wt',
    label: 'Chat',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  } satisfies Tab
}

describe('which chats moved conversation', () => {
  it('finds a tab that now shows another conversation, and nothing else', () => {
    const previous = {
      wt: [chat('t1', 'a'), chat('t2', 'c'), chat('term', 'pty-1', 'terminal')],
      other: [chat('t9', 'z')]
    }
    const next = {
      wt: [chat('t1', 'b'), chat('t2', 'c'), chat('t3', 'a'), chat('term', 'pty-2', 'terminal')],
      other: previous.other,
      added: [chat('t4', 'y')]
    }
    expect(structuredAgentSessionConversationMoves(previous, next)).toEqual([
      { from: 'a', to: 'b' }
    ])
  })
})
