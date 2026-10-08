// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { dispatchStructuredAgentSessionComposerCommand } from '../../../../shared/structured-agent-session-composer'
import type { NativeChatStructuredComposerTransport } from './native-chat-composer-types'
import { useNativeChatStructuredComposerSend } from './use-native-chat-structured-composer-send'
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
import { writeNativeChatDraftCache } from './native-chat-draft-cache'
import { moveStructuredAgentSessionDraft } from './structured-agent-session-draft-move'

vi.mock('@/lib/native-chat-telemetry', () => ({ emitNativeChatMessageSent: vi.fn() }))
vi.mock('@/lib/worker-terminal-takeover-report', () => ({
  reportStructuredSessionUserInput: vi.fn()
}))

const from = structuredAgentSessionDraftScopeKey('session-a')
const to = structuredAgentSessionDraftScopeKey('session-b')

beforeEach(async () => {
  setNativeChatComposerDraftStorageForTests(createMemoryNativeChatComposerDraftStorage())
  await hydrateNativeChatComposerDrafts()
})

afterEach(() => {
  clearNativeChatComposerDraftsForTests()
})

// The host moves the chat before the command reply lands.
async function clearHarness() {
  updateNativeChatComposerDraft(from, { text: '/clear' }, 'immediate')
  let reply: (accepted: boolean) => void = () => {}
  const transport: NativeChatStructuredComposerTransport = {
    send: vi.fn(() => true),
    dispatchCommand: (text: string) =>
      dispatchStructuredAgentSessionComposerCommand(text, {
        agent: 'codex',
        snapshot: [],
        invokeAction: async () => true,
        setOption: async () => true,
        conversationCommands: ['clear'],
        runConversationCommand: () =>
          new Promise((resolve) => {
            reply = (accepted) => resolve({ accepted, error: accepted ? null : 'not cleared' })
          })
      }),
    optionsSurface: {
      getSnapshot: () => [],
      setOption: vi.fn(),
      invokeAction: vi.fn(),
      subscribe: () => () => {}
    },
    optionSnapshot: [],
    onError: vi.fn(),
    runtime: 'local',
    sessionId: 'session-a',
    runtimeEnvironmentId: null
  }
  const { result } = renderHook(() =>
    useNativeChatStructuredComposerSend({
      agent: 'codex',
      draftScopeKey: from,
      imageAttachments: [],
      structuredTransport: transport,
      isComposing: () => false,
      clearSkillOrigin: vi.fn(),
      setDraft: (value) => writeNativeChatDraftCache(from, value),
      setCaret: vi.fn()
    })
  )

  return { send: result.current, reply: (accepted: boolean) => reply(accepted) }
}

it('moves only what was typed after /clear when the chat moves before the reply', async () => {
  const { send, reply } = await clearHarness()
  const sent = send('/clear')
  expect(readNativeChatComposerDraft(from).text).toBe('')
  updateNativeChatComposerDraft(from, { text: 'next question' }, 'immediate')
  await moveStructuredAgentSessionDraft('session-a', 'session-b')
  reply(true)
  await sent

  expect(readNativeChatComposerDraft(to).text).toBe('next question')
  expect(readNativeChatComposerDraft(from).text).toBe('')
})

it('restores a refused clear command if no new draft replaced it', async () => {
  const { send, reply } = await clearHarness()
  const sent = send('/clear')
  expect(readNativeChatComposerDraft(from).text).toBe('')
  reply(false)
  await sent
  expect(readNativeChatComposerDraft(from).text).toBe('/clear')
})

it('leaves text and images typed after a refused clear untouched', async () => {
  const { send, reply } = await clearHarness()
  const sent = send('/clear')
  const image = { id: 'image', path: '/remote/image.png', connectionId: 'ssh-1' }
  updateNativeChatComposerDraft(from, { text: 'next question', images: [image] }, 'immediate')
  reply(false)
  await sent
  expect(readNativeChatComposerDraft(from)).toMatchObject({
    text: 'next question',
    images: [image]
  })
})

it('leaves the new composer empty when clear succeeds with no following input', async () => {
  const { send, reply } = await clearHarness()
  const sent = send('/clear')
  await moveStructuredAgentSessionDraft('session-a', 'session-b')
  reply(true)
  await sent
  expect(readNativeChatComposerDraft(to)).toMatchObject({ text: '', images: [] })
  expect(readNativeChatComposerDraft(from)).toMatchObject({ text: '', images: [] })
})
