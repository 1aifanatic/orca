// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { dispatchStructuredAgentSessionComposerCommand } from '../../../../shared/structured-agent-session-composer'
import type { NativeChatStructuredComposerTransport } from './native-chat-composer-types'
import { useNativeChatStructuredComposerSend } from './use-native-chat-structured-composer-send'
import {
  clearNativeChatComposerDraftsForTests,
  readNativeChatComposerDraft,
  structuredAgentSessionDraftScopeKey,
  updateNativeChatComposerDraft
} from './native-chat-composer-draft-store'
import {
  noteStructuredAgentSessionClearedInto,
  resetStructuredAgentSessionClearCarryForTests
} from './structured-agent-session-clear-draft-carry'

vi.mock('@/lib/native-chat-telemetry', () => ({ emitNativeChatMessageSent: vi.fn() }))
vi.mock('@/lib/worker-terminal-takeover-report', () => ({
  reportStructuredSessionUserInput: vi.fn()
}))

afterEach(() => {
  resetStructuredAgentSessionClearCarryForTests()
  clearNativeChatComposerDraftsForTests()
})

// A /clear moves the chat to a new conversation, and the box then shows that conversation's draft.
it('takes what was typed while a /clear ran into the conversation the chat moved to', async () => {
  const from = structuredAgentSessionDraftScopeKey('session-a')
  const to = structuredAgentSessionDraftScopeKey('session-b')
  updateNativeChatComposerDraft(from, { text: '/clear' }, 'immediate')
  let settle: () => void = () => {}
  const transport: NativeChatStructuredComposerTransport = {
    send: vi.fn(() => true),
    dispatchCommand: (text) =>
      dispatchStructuredAgentSessionComposerCommand(text, {
        agent: 'codex',
        snapshot: [],
        invokeAction: async () => true,
        setOption: async () => true,
        conversationCommands: ['clear'],
        runConversationCommand: () =>
          new Promise((resolve) => {
            settle = () => {
              noteStructuredAgentSessionClearedInto('session-a', 'session-b')
              resolve({ accepted: true, error: null })
            }
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
      setDraft: vi.fn(),
      setCaret: vi.fn()
    })
  )
  const sent = result.current('/clear')
  // Typed over the command while it ran.
  updateNativeChatComposerDraft(from, { text: 'c4 during clear' }, 'immediate')
  settle()
  await sent

  expect(readNativeChatComposerDraft(to).text).toBe('c4 during clear')
  expect(readNativeChatComposerDraft(from).text).toBe('')
})
