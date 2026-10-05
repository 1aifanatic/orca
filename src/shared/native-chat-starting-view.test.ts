import { describe, expect, it } from 'vitest'
import {
  canMirrorLaunchDraftToNativeChat,
  finalizeAgentTabStartingView
} from './native-chat-starting-view'

const chatDefault = { experimentalNativeChat: true, openAgentTabsInChatByDefault: true }
const terminalDefault = { experimentalNativeChat: true, openAgentTabsInChatByDefault: false }

describe('finalizeAgentTabStartingView', () => {
  it("applies the deciding host's default when the launcher sent no choice", () => {
    expect(finalizeAgentTabStartingView({ settings: chatDefault, agent: 'claude' })).toBe('chat')
    // Explicit terminal, never absent: absent means an old unswitched tab to every reader.
    expect(finalizeAgentTabStartingView({ settings: terminalDefault, agent: 'claude' })).toBe(
      'terminal'
    )
    expect(finalizeAgentTabStartingView({ settings: null, agent: 'claude' })).toBe('terminal')
  })

  it("lets the launching device's explicit choice win over the host's default", () => {
    expect(
      finalizeAgentTabStartingView({ request: 'terminal', settings: chatDefault, agent: 'claude' })
    ).toBe('terminal')
    expect(
      finalizeAgentTabStartingView({ request: 'chat', settings: terminalDefault, agent: 'claude' })
    ).toBe('chat')
    // The host's own experimental opt-out is a fallback input, not a veto of the launcher.
    expect(finalizeAgentTabStartingView({ request: 'chat', settings: null, agent: 'claude' })).toBe(
      'chat'
    )
  })

  it('starts terminal when chat cannot show the launch, whoever asked for chat', () => {
    expect(finalizeAgentTabStartingView({ request: 'chat', settings: null, agent: 'aider' })).toBe(
      'terminal'
    )
    expect(
      finalizeAgentTabStartingView({
        settings: chatDefault,
        agent: 'grok',
        nativeChatTranscriptIsLocalReadable: false
      })
    ).toBe('terminal')
    expect(
      finalizeAgentTabStartingView({
        settings: chatDefault,
        agent: 'grok',
        nativeChatTranscriptIsLocalReadable: true
      })
    ).toBe('chat')
    expect(
      finalizeAgentTabStartingView({
        request: 'chat',
        settings: chatDefault,
        agent: 'claude',
        promptDelivery: 'draft',
        launchDraftText: 'a\u2028b'
      })
    ).toBe('terminal')
  })

  it('gives a plain shell no starting view', () => {
    expect(finalizeAgentTabStartingView({ request: 'chat', settings: chatDefault })).toBe(undefined)
  })

  it('is idempotent, so a second host pass never changes a final value', () => {
    for (const request of ['chat', 'terminal'] as const) {
      const once = finalizeAgentTabStartingView({ request, settings: chatDefault, agent: 'codex' })
      expect(
        finalizeAgentTabStartingView({ request: once, settings: terminalDefault, agent: 'codex' })
      ).toBe(once)
    }
  })
})

describe('canMirrorLaunchDraftToNativeChat (moved, unchanged)', () => {
  it('accepts a CR/LF draft and refuses empty or Unicode line separators', () => {
    expect(canMirrorLaunchDraftToNativeChat('fix\r\nthe bug')).toBe(true)
    expect(canMirrorLaunchDraftToNativeChat('   ')).toBe(false)
    expect(canMirrorLaunchDraftToNativeChat('a\u2029b')).toBe(false)
  })
})
