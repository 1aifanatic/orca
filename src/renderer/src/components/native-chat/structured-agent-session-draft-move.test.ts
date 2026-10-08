// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Tab } from '../../../../shared/tab-types'
import {
  moveStructuredAgentSessionDraft,
  structuredAgentSessionConversationMoves
} from './structured-agent-session-draft-move'
import {
  clearNativeChatComposerDraftsForTests,
  hydrateNativeChatComposerDrafts,
  isNativeChatComposerDraftUnverified,
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
  clearNativeChatComposerDraftsForTests()
})

describe('moving a cleared conversation draft', () => {
  it('moves text, SSH images and skill chips whole into the new conversation', async () => {
    const document = { type: 'doc', content: [{ type: 'paragraph' }] }
    updateNativeChatComposerDraft(
      scope('a'),
      { text: 'typed during clear', document, images: [SSH_IMAGE] },
      'immediate'
    )

    await moveStructuredAgentSessionDraft('a', 'b')

    expect(readNativeChatComposerDraft(scope('b'))).toMatchObject({
      text: 'typed during clear',
      document,
      images: [SSH_IMAGE]
    })
    expect(readNativeChatComposerDraft(scope('a'))).toMatchObject({ text: '', images: [] })
  })

  it('goes after what the new conversation already holds', async () => {
    updateNativeChatComposerDraft(scope('a'), { text: 'moved' }, 'immediate')
    updateNativeChatComposerDraft(scope('b'), { text: 'already here' }, 'immediate')

    await moveStructuredAgentSessionDraft('a', 'b')

    expect(readNativeChatComposerDraft(scope('b')).text).toBe('already here\n\nmoved')
  })

  it('moves nothing from an empty draft', async () => {
    updateNativeChatComposerDraft(scope('b'), { text: 'mine' }, 'immediate')
    await moveStructuredAgentSessionDraft('a', 'b')
    expect(readNativeChatComposerDraft(scope('b')).text).toBe('mine')
  })

  it('keeps the source when saving the destination fails', async () => {
    const storage = createMemoryNativeChatComposerDraftStorage()
    setNativeChatComposerDraftStorageForTests(storage)
    updateNativeChatComposerDraft(scope('a'), { text: 'still owed' }, 'immediate')
    storage.refuseWrites = true

    await moveStructuredAgentSessionDraft('a', 'b')

    expect(readNativeChatComposerDraft(scope('a')).text).toBe('still owed')
    expect(readNativeChatComposerDraft(scope('b')).text).toBe('still owed')
    storage.refuseWrites = false
    await moveStructuredAgentSessionDraft('a', 'b')
    expect(readNativeChatComposerDraft(scope('b')).text).toBe('still owed')
    expect(readNativeChatComposerDraft(scope('a')).text).toBe('')
  })

  it('saves the skill document before removing its source, and restores it after restart', async () => {
    const storage = createMemoryNativeChatComposerDraftStorage()
    setNativeChatComposerDraftStorageForTests(storage)
    const document = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'nativeChatSkill', attrs: { token: '/review' } }] }
      ]
    }
    updateNativeChatComposerDraft(
      scope('a'),
      { text: '/review', document, images: [SSH_IMAGE] },
      'immediate'
    )

    await moveStructuredAgentSessionDraft('a', 'b')
    expect(storage.drafts.get(scope('b'))).toMatchObject({ document, images: [SSH_IMAGE] })
    clearNativeChatComposerDraftsForTests()
    setNativeChatComposerDraftStorageForTests(storage)
    await hydrateNativeChatComposerDrafts()
    expect(readNativeChatComposerDraft(scope('b'))).toMatchObject({
      text: '/review',
      document,
      images: [SSH_IMAGE]
    })
    expect(readNativeChatComposerDraft(scope('a')).text).toBe('')
  })

  it('keeps unavailable images intact and deduplicates an already copied image', async () => {
    const image = { id: 'missing', path: '', unavailableName: 'notes.png' }
    updateNativeChatComposerDraft(scope('a'), { text: 'moved', images: [image] }, 'immediate')
    updateNativeChatComposerDraft(scope('b'), { text: 'moved', images: [image] }, 'immediate')
    await moveStructuredAgentSessionDraft('a', 'b')
    expect(readNativeChatComposerDraft(scope('b'))).toMatchObject({
      text: 'moved',
      images: [image]
    })
  })

  it('does not clear a source edited while the destination save is outstanding', async () => {
    updateNativeChatComposerDraft(scope('a'), { text: 'moved' }, 'immediate')
    const moving = moveStructuredAgentSessionDraft('a', 'b')
    updateNativeChatComposerDraft(scope('a'), { text: 'new old-chat draft' }, 'immediate')
    await moving
    expect(readNativeChatComposerDraft(scope('a')).text).toBe('new old-chat draft')
    expect(readNativeChatComposerDraft(scope('b')).text).toBe('moved')
  })

  it('waits for the saved drafts to load before moving one only storage holds', async () => {
    clearNativeChatComposerDraftsForTests()
    const storage = createMemoryNativeChatComposerDraftStorage()
    storage.drafts.set(scope('a'), { text: 'saved before quit', images: [SSH_IMAGE], savedAt: 1 })
    setNativeChatComposerDraftStorageForTests(storage)
    const loading = hydrateNativeChatComposerDrafts()

    await moveStructuredAgentSessionDraft('a', 'b')
    await loading
    await Promise.resolve()

    expect(readNativeChatComposerDraft(scope('b')).text).toBe('saved before quit')
    expect(readNativeChatComposerDraft(scope('a')).text).toBe('')
    expect(isNativeChatComposerDraftUnverified(scope('b'))).toBe(true)
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

it('derives a move from a first host replacement and ignores repeated publication', () => {
  const target = { ...chat('new-tab', 'b'), agentSessionReplacesSessionId: 'a' }
  expect(structuredAgentSessionConversationMoves({}, { wt: [target] })).toEqual([
    { from: 'a', to: 'b' }
  ])
  expect(
    structuredAgentSessionConversationMoves({ wt: [target] }, { wt: [{ ...target }] })
  ).toEqual([])
})

it('keeps a draft in a source explicitly reopened from history after restart', () => {
  const target = { ...chat('new-tab', 'b'), agentSessionReplacesSessionId: 'a' }
  expect(
    structuredAgentSessionConversationMoves({}, { wt: [target, chat('history', 'a')] })
  ).toEqual([])
})
