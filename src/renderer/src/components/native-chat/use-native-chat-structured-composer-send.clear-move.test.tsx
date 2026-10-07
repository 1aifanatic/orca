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
import {
  moveStructuredAgentSessionDraft,
  resetStructuredAgentSessionDraftMoveForTests
} from './structured-agent-session-draft-move'

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
  resetStructuredAgentSessionDraftMoveForTests()
  clearNativeChatComposerDraftsForTests()
})

// The host moves the chat's tab before the /clear's reply lands, and the box holds "/clear" until then.
it('moves only what was typed after /clear when the chat moves before the reply', async () => {
  updateNativeChatComposerDraft(from, { text: '/clear' }, 'immediate')
  let reply: () => void = () => {}
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
            reply = () => resolve({ accepted: true, error: null })
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
      setHistory: vi.fn(),
      setDraft: (value) => writeNativeChatDraftCache(from, value),
      setCaret: vi.fn()
    })
  )

  const sent = result.current('/clear')
  updateNativeChatComposerDraft(from, { text: '/clear\nnext question' }, 'immediate')
  moveStructuredAgentSessionDraft('session-a', 'session-b')
  reply()
  await sent

  expect(readNativeChatComposerDraft(to).text).toBe('\nnext question')
  expect(readNativeChatComposerDraft(from).text).toBe('')
})
