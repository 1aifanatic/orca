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
  subscribeToNativeChatComposerDraft,
  nativeChatComposerDraftWritesSettled,
  flushNativeChatComposerDrafts,
  isNativeChatComposerDraftUnsaved,
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
    const document = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'before ' },
            { type: 'nativeChatSkill', attrs: { token: '$review' } },
            { type: 'text', text: ' after' }
          ]
        }
      ]
    }
    updateNativeChatComposerDraft(
      scope('a'),
      { text: 'before $review after', document, images: [SSH_IMAGE] },
      'immediate'
    )

    await moveStructuredAgentSessionDraft('a', 'b')

    expect(readNativeChatComposerDraft(scope('b'))).toMatchObject({
      text: 'before $review after',
      document,
      images: [SSH_IMAGE]
    })
    expect(readNativeChatComposerDraft(scope('a'))).toMatchObject({ text: '', images: [] })
  })

  it.each(['text', 'image', 'skill'] as const)(
    'keeps both drafts intact when the destination has %s input',
    (kind) => {
      const source = {
        text: '$review-long',
        document: {
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'nativeChatSkill', attrs: { token: '$review-long' } }]
            }
          ]
        },
        images: [SSH_IMAGE]
      }
      const destination =
        kind === 'image'
          ? { text: '', images: [SSH_IMAGE] }
          : kind === 'text'
            ? { text: '$review-long', images: [] }
            : {
                text: '$review-long',
                images: [],
                document: {
                  type: 'doc',
                  content: [
                    {
                      type: 'paragraph',
                      content: [
                        { type: 'nativeChatSkill', attrs: { token: '$review' } },
                        { type: 'text', text: '-long' }
                      ]
                    }
                  ]
                }
              }
      updateNativeChatComposerDraft(scope('a'), source, 'immediate')
      updateNativeChatComposerDraft(scope('b'), destination, 'immediate')
      const originalSource = readNativeChatComposerDraft(scope('a'))
      const originalTarget = readNativeChatComposerDraft(scope('b'))
      moveStructuredAgentSessionDraft('a', 'b')
      expect(readNativeChatComposerDraft(scope('a'))).toBe(originalSource)
      expect(readNativeChatComposerDraft(scope('b'))).toBe(originalTarget)
    }
  )

  it('moves nothing from an empty draft', async () => {
    updateNativeChatComposerDraft(scope('b'), { text: 'mine' }, 'immediate')
    await moveStructuredAgentSessionDraft('a', 'b')
    expect(readNativeChatComposerDraft(scope('b')).text).toBe('mine')
  })

  it('keeps the moved draft in memory through a refused save and repairs it on a normal flush', async () => {
    const storage = createMemoryNativeChatComposerDraftStorage()
    setNativeChatComposerDraftStorageForTests(storage)
    updateNativeChatComposerDraft(scope('a'), { text: 'still owed' }, 'immediate')
    await nativeChatComposerDraftWritesSettled()
    storage.refuseWrites = true
    moveStructuredAgentSessionDraft('a', 'b')
    await nativeChatComposerDraftWritesSettled()
    expect(readNativeChatComposerDraft(scope('a')).text).toBe('')
    expect(readNativeChatComposerDraft(scope('b')).text).toBe('still owed')
    expect(isNativeChatComposerDraftUnsaved(scope('b'))).toBe(true)
    storage.refuseWrites = false
    flushNativeChatComposerDrafts()
    await nativeChatComposerDraftWritesSettled()
    expect(storage.drafts.get(scope('b'))?.text).toBe('still owed')
    expect(storage.drafts.has(scope('a'))).toBe(false)
    expect(isNativeChatComposerDraftUnsaved(scope('b'))).toBe(false)
  })

  it('publishes both scope changes before any subscriber observes the move', () => {
    updateNativeChatComposerDraft(
      scope('a'),
      { text: 'question', images: [SSH_IMAGE] },
      'immediate'
    )
    const seen: { source: string; target: string }[] = []
    const observe = (): void => {
      seen.push({
        source: readNativeChatComposerDraft(scope('a')).text,
        target: readNativeChatComposerDraft(scope('b')).text
      })
    }
    const unsubscribeSource = subscribeToNativeChatComposerDraft(scope('a'), observe)
    const unsubscribeTarget = subscribeToNativeChatComposerDraft(scope('b'), observe)
    moveStructuredAgentSessionDraft('a', 'b')
    unsubscribeSource()
    unsubscribeTarget()
    expect(seen).toEqual([
      { source: '', target: 'question' },
      { source: '', target: 'question' }
    ])
    expect(readNativeChatComposerDraft(scope('b')).images).toEqual([SSH_IMAGE])
  })

  it('saves the whole moved draft through the store and restores it after restart', async () => {
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

  it('keeps unavailable images intact in the whole transferred record', () => {
    const image = { id: 'missing', path: '', unavailableName: 'notes.png' }
    updateNativeChatComposerDraft(scope('a'), { text: 'moved', images: [image] }, 'immediate')
    moveStructuredAgentSessionDraft('a', 'b')
    expect(readNativeChatComposerDraft(scope('b'))).toMatchObject({
      text: 'moved',
      images: [image]
    })
    expect(readNativeChatComposerDraft(scope('a')).images).toEqual([])
  })

  it('keeps new history input entered after the synchronous move', async () => {
    updateNativeChatComposerDraft(scope('a'), { text: 'moved' }, 'immediate')
    const moving = moveStructuredAgentSessionDraft('a', 'b')
    updateNativeChatComposerDraft(scope('a'), { text: 'new old-chat draft' }, 'immediate')
    await moving
    expect(readNativeChatComposerDraft(scope('a')).text).toBe('new old-chat draft')
    expect(readNativeChatComposerDraft(scope('b')).text).toBe('moved')
  })

  it('keeps a later history write even when it recreates the moved text', async () => {
    updateNativeChatComposerDraft(scope('a'), { text: 'same question' }, 'immediate')
    const moving = moveStructuredAgentSessionDraft('a', 'b')
    updateNativeChatComposerDraft(scope('a'), { text: '' }, 'immediate')
    updateNativeChatComposerDraft(scope('a'), { text: 'same question' }, 'immediate')
    await moving
    expect(readNativeChatComposerDraft(scope('a')).text).toBe('same question')
    expect(readNativeChatComposerDraft(scope('b')).text).toBe('same question')
  })

  it('moves a restored source only after the load has finished', async () => {
    clearNativeChatComposerDraftsForTests()
    const storage = createMemoryNativeChatComposerDraftStorage()
    storage.drafts.set(scope('a'), { text: 'saved before quit', images: [SSH_IMAGE], savedAt: 1 })
    setNativeChatComposerDraftStorageForTests(storage)
    await hydrateNativeChatComposerDrafts()
    moveStructuredAgentSessionDraft('a', 'b')
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
