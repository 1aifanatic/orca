// @vitest-environment happy-dom

// A send that a /clear raced: the host refused it before recording anything, so it leaves the
// outbox and its text goes back to the composer — after the pane moved to the new conversation,
// that one's — with why said once on that composer's line.

import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session-journal-types'

const mocks = vi.hoisted(() => ({
  call: vi.fn<(target: unknown, method: string, params: unknown) => Promise<unknown>>()
}))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call
}))

import {
  clearNativeChatDraftCacheForTests,
  readNativeChatDraftCache
} from './native-chat-draft-cache'
import { structuredAgentSessionDraftScopeKey as scope } from './native-chat-composer-draft-store'
import {
  clearNativeChatComposerDraftForwardingForTests,
  forwardStructuredAgentSessionDraft
} from './native-chat-composer-draft-forwarding'
import { clearStructuredAgentSessionHandedBackNoticesForTests } from './structured-agent-session-handed-back-notice'
import { useStructuredAgentSessionOutbox } from './use-structured-agent-session-outbox'

const NO_JOURNAL_ITEMS: readonly AgentJournalRenderItem[] = []
const CLEARED = "The chat was cleared before your message went out. It's back in the composer."

afterEach(cleanup)

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  clearNativeChatDraftCacheForTests()
  clearNativeChatComposerDraftForwardingForTests()
  clearStructuredAgentSessionHandedBackNoticesForTests()
})

function outbox(sessionId: string) {
  return renderHook(() =>
    useStructuredAgentSessionOutbox({
      journalItems: NO_JOURNAL_ITEMS,
      sessionId,
      target: { kind: 'local' },
      fence: 1,
      submissions: [],
      composerScopeKey: scope(sessionId)
    })
  )
}

const REFUSED_AS_CLEARED = {
  ok: false,
  refusal: {
    code: 'agent_session_operation_invalid',
    details: { reason: 'conversationCleared' },
    message: 'This conversation has been cleared. Use the current conversation.'
  }
}

it('gives the text back to the composer and says why once, with no row or Retry left', async () => {
  mocks.call.mockResolvedValueOnce(REFUSED_AS_CLEARED)
  const { result } = outbox('old')
  act(() => expect(result.current.send('typed as the clear ran')).toBe(true))
  await waitFor(() => expect(result.current.outbox).toEqual([]))
  expect(readNativeChatDraftCache(scope('old'))).toBe('typed as the clear ran')
  expect(result.current.error).toBe(CLEARED)
})

it('answered after the pane moved on, lands in the new conversation with its words', async () => {
  let answer: () => void = () => {}
  mocks.call.mockImplementationOnce(async () => {
    await new Promise<void>((resolve) => {
      answer = resolve
    })
    return REFUSED_AS_CLEARED
  })
  const old = outbox('old')
  act(() => expect(old.result.current.send('typed as the clear ran')).toBe(true))
  await waitFor(() => expect(mocks.call).toHaveBeenCalledOnce())
  // The /clear's tab move: the old pane goes, the new conversation's mounts.
  old.unmount()
  forwardStructuredAgentSessionDraft('old', 'new')
  const replacement = outbox('new')
  act(() => answer())
  await waitFor(() => expect(readNativeChatDraftCache(scope('new'))).toBe('typed as the clear ran'))
  expect(readNativeChatDraftCache(scope('old'))).toBe('')
  await waitFor(() => expect(replacement.result.current.error).toBe(CLEARED))
})
