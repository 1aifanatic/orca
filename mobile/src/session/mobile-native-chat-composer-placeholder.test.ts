import { describe, expect, it } from 'vitest'
import { mobileNativeChatComposerPlaceholder } from './mobile-native-chat-composer-placeholder'

describe("the phone chat composer's placeholder", () => {
  it('says a message runs after the stop while the chat reads Stopping', () => {
    expect(mobileNativeChatComposerPlaceholder(null, true)).toBe(
      'Queue a message to run after the stop'
    )
  })

  it('reads as usual otherwise', () => {
    expect(mobileNativeChatComposerPlaceholder(null, false)).toBe('Message, @files, /commands')
  })

  it('says why the composer is locked first', () => {
    expect(mobileNativeChatComposerPlaceholder('disconnected', true)).toBe('Reconnecting…')
    expect(mobileNativeChatComposerPlaceholder('waiting', true)).toBe('Waiting for terminal…')
  })
})
