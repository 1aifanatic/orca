import { afterEach, expect, it, vi } from 'vitest'
import { setStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import {
  currentConversationReplacements,
  withListingConversationReplacements
} from './structured-conversation-replacements-scope'

afterEach(() => {
  setStructuredAgentSessionHost(null)
})

function hostDeriving() {
  const conversationReplacements = vi.fn(() => [])
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the scope reads only this member.
  setStructuredAgentSessionHost({ conversationReplacements } as never)
  return conversationReplacements
}

it('derives once inside a listing, across its awaits', async () => {
  const derive = hostDeriving()

  await withListingConversationReplacements(async () => {
    currentConversationReplacements()
    await new Promise((resolve) => setTimeout(resolve, 1))
    currentConversationReplacements()
  })

  expect(derive).toHaveBeenCalledOnce()
})

it('derives on every call outside a listing', () => {
  const derive = hostDeriving()

  currentConversationReplacements()
  currentConversationReplacements()

  expect(derive).toHaveBeenCalledTimes(2)
})

it('derives fresh in work a listing started that outlives it', async () => {
  const derive = hostDeriving()
  const later = Promise.withResolvers<void>()

  await withListingConversationReplacements(async () => {
    currentConversationReplacements()
    setTimeout(() => {
      currentConversationReplacements()
      later.resolve()
    }, 5)
  })
  await later.promise

  expect(derive).toHaveBeenCalledTimes(2)
})
