import { describe, expect, it } from 'vitest'
import { resolveInitialNativeChatSessionOptions } from './native-chat-launch-session-options'

const settings = {
  experimentalNativeChat: true,
  nativeChatSessionOptions: {
    codex: {
      model: 'gpt-5.2-codex',
      valuesByModel: { 'gpt-5.2-codex': { effort: 'medium' } }
    }
  }
}

describe('resolveInitialNativeChatSessionOptions', () => {
  it('omits native-chat preferences from terminal-default launches', () => {
    expect(
      resolveInitialNativeChatSessionOptions(
        { ...settings, experimentalNativeChat: false },
        { agent: 'codex' }
      )
    ).toBeUndefined()
  })

  it('applies native-chat preferences when the launch resolves to chat', () => {
    expect(resolveInitialNativeChatSessionOptions(settings, { agent: 'codex' })).toEqual({
      model: 'gpt-5.2-codex',
      effort: 'medium'
    })
  })

  it('retains saved options for structured drafts beyond the terminal mirror limit', () => {
    expect(
      resolveInitialNativeChatSessionOptions(settings, {
        agent: 'codex',
        promptDelivery: 'draft',
        launchDraftText: 'one\u2028two'
      })
    ).toEqual({ model: 'gpt-5.2-codex', effort: 'medium' })
  })

  it('retains saved options for a registered structured agent regardless of transcript location', () => {
    const grokSettings = {
      ...settings,
      nativeChatSessionOptions: { grok: { model: 'grok-4.5' } }
    }
    expect(
      resolveInitialNativeChatSessionOptions(grokSettings, {
        agent: 'grok',
        nativeChatTranscriptIsLocalReadable: false
      })
    ).toEqual({ model: 'grok-4.5' })
  })
})
