import { describe, expect, it } from 'vitest'
import {
  normalizeStructuredChatLaunchOptions,
  resolveStructuredChatLaunchOptions
} from './structured-chat-launch-options'

describe('new chat permission support', () => {
  it('retains reviewer intent for host confirmation and narrows provider-incompatible choices', () => {
    expect(
      resolveStructuredChatLaunchOptions({ nativeChatPermissionMode: 'auto' }, 'claude')
    ).toEqual({ permissionMode: 'auto' })
    expect(
      resolveStructuredChatLaunchOptions({ nativeChatPermissionMode: 'accept-edits' }, 'codex')
    ).toEqual({ permissionMode: 'ask' })
    expect(normalizeStructuredChatLaunchOptions('pi', { permissionMode: 'bypass' })).toEqual({})
  })
})
