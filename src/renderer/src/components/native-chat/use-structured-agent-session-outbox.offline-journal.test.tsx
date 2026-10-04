// @vitest-environment happy-dom

// Losing contact is no evidence the host holds nothing. A message is handed back on the journal's
// word only while that journal is live; a stale one kept through an outage decides nothing, and a
// message that slept past the host's window is sent again so the host's own answer decides.

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalCursor } from '../../../../shared/agent-session-journal-types'
import { AGENT_SESSION_MAX_OPERATION_REPLAY_AGE_MS } from '../../../../shared/agent-session-host-authority'
import { createStructuredAgentSessionOperationId } from '../../../../shared/structured-agent-session-mutation'
import { createStructuredAgentSessionOutboxEntry } from '../../../../shared/structured-agent-session-outbox'

const mocks = vi.hoisted(() => ({
  call: vi.fn<(...args: unknown[]) => Promise<unknown>>()
}))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

import { createBrowserUuid } from '@/lib/browser-uuid'
import { useStructuredAgentSessionOutbox } from './use-structured-agent-session-outbox'
import { useStructuredAgentSessionConversationStop } from './use-structured-agent-session-conversation-stop'
import type {
  StructuredAgentSessionWriteAs,
  StructuredAgentSessionWriteOutcome
} from './use-structured-agent-session-mutate'
import { readOutbox, writeOutbox } from './structured-agent-session-outbox-storage'
import { structuredAgentSessionDraftScopeKey } from './native-chat-composer-draft-store'
import {
  clearNativeChatDraftCacheForTests,
  readNativeChatDraftCache
} from './native-chat-draft-cache'
import { resetStructuredAgentSessionChatLinesForTests } from './structured-agent-session-returned-send'

const SCOPE = structuredAgentSessionDraftScopeKey('session-1')
const CURSOR: AgentJournalCursor = { epoch: 'e', sequence: 3 }
const LOST: StructuredAgentSessionWriteOutcome<unknown> = {
  kind: 'not-done',
  notice: "The agent wasn't stopped.",
  answered: false
}

afterEach(cleanup)

beforeEach(() => {
  localStorage.clear()
  clearNativeChatDraftCacheForTests()
  resetStructuredAgentSessionChatLinesForTests()
  mocks.call.mockReset()
  mocks.call.mockImplementation(() => new Promise(() => {}))
})

function seedSent(text: string, madeAt = Date.now() - 60_000): string {
  const clientMessageId = createStructuredAgentSessionOperationId(createBrowserUuid, madeAt)
  writeOutbox('session-1', [
    {
      ...createStructuredAgentSessionOutboxEntry({
        clientMessageId,
        sessionId: 'session-1',
        text,
        attachments: [],
        queuedAt: madeAt
      }),
      state: 'unconfirmed',
      lastAttemptAt: madeAt
    }
  ])
  return clientMessageId
}

/** The chat as the session wires it: the journal decides only while it is live. */
function mountChat(writeAs: StructuredAgentSessionWriteAs) {
  return renderHook(
    (props: { live: boolean }) => {
      const outbox = useStructuredAgentSessionOutbox({
        sessionId: 'session-1',
        target: { kind: 'local' },
        fence: 1,
        submissions: [],
        journalCursor: props.live ? CURSOR : null
      })
      const stop = useStructuredAgentSessionConversationStop({
        outbox: outbox.outbox,
        submissions: [],
        attached: props.live,
        writeAs,
        stopOutbox: outbox.stop,
        recordStopAnswer: outbox.recordStopAnswer
      })
      return { outbox, stop }
    },
    { initialProps: { live: true } }
  )
}

function asWriteAs(write: () => Promise<StructuredAgentSessionWriteOutcome<unknown>>) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the Stop hook calls writeAs only for agentSession.cancel and reads kind, cursor, answered and notice, never the value's type.
  return write as unknown as StructuredAgentSessionWriteAs
}

describe('while the journal is not live', () => {
  it('a Stop outran by a newer send hands nothing back until the journal is live again', async () => {
    seedSent('in flight at the Stop')
    const view = mountChat(asWriteAs(async () => LOST))
    view.rerender({ live: false })

    // Offline: the Stop's answer is lost, and the person sends something newer.
    await act(async () => {
      await view.result.current.stop()
    })
    act(() => {
      view.result.current.outbox.send('newer')
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50))
    })
    expect(readOutbox('session-1')[0]).toMatchObject({
      stoppedBy: expect.not.objectContaining({ unanswerable: true })
    })
    expect(readNativeChatDraftCache(SCOPE)).toBe('')

    // Live again: the Stop is given up, and the journal, with no row for it, hands it back.
    view.rerender({ live: true })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50))
    })
    expect(readNativeChatDraftCache(SCOPE)).toBe('in flight at the Stop')
  })

  it('a message that slept past the host window is sent again before anything hands it back', async () => {
    const id = seedSent(
      'slept through',
      Date.now() - AGENT_SESSION_MAX_OPERATION_REPLAY_AGE_MS - 60_000
    )
    mocks.call.mockResolvedValue({
      ok: false,
      refusal: { code: 'agent_session_operation_expired', message: 'expired' }
    })
    const view = mountChat(asWriteAs(async () => LOST))

    await vi.waitFor(() => expect(mocks.call).toHaveBeenCalled(), { timeout: 3000 })
    expect(JSON.stringify(mocks.call.mock.calls[0]?.[2])).toContain(id)
    // The host's answer (expired, no row in the journal) is what hands it back.
    await vi.waitFor(() => expect(readNativeChatDraftCache(SCOPE)).toBe('slept through'))
    expect(view.result.current.outbox.error).toBe(
      "Orca couldn't confirm your message reached the agent. Check the chat, then send it again if needed."
    )
  })
})
