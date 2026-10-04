// What a chat does on the coordinator-mail rig: a turn held running, the person's Delete on a card,
// and idle edges with nothing owed.

import { expect, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../shared/agent-session-mutation-envelope'
import { operationId, type FakeConnection } from './structured-chat-coordinator-fake-codex-fixture'
import {
  COORDINATOR,
  WAIT,
  host,
  runtime,
  sendUserMessage
} from './structured-chat-coordinator-mail-rig.test-fixture'

/** Idle edges with nothing owed: whatever they would start gets the time to show. */
export async function idleEdgesSettled(sessionId = COORDINATOR): Promise<void> {
  for (let edge = 0; edge < 3; edge += 1) {
    runtime.onStructuredSessionStatusForMail({ sessionId, status: 'idle' })
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

/** A turn running in the chat; resolves to its end. */
export async function runningTurn(
  chat: FakeConnection,
  index: number,
  sessionId = COORDINATOR
): Promise<() => Promise<void>> {
  await vi.waitFor(() => expect(chat.turns).toHaveLength(index + 1), WAIT)
  const notify = (method: string, params: unknown) => chat.handlers.onNotification?.(method, params)
  const turnId = `turn-${index + 1}`
  notify('turn/started', { turn: { id: turnId } })
  notify('item/completed', {
    item: {
      type: 'userMessage',
      id: `echo-${index}`,
      clientId: chat.turns[index]!.clientUserMessageId,
      content: [{ type: 'text', text: 'echo' }]
    }
  })
  await host.flushStreamedEvents(sessionId)
  return async () => {
    notify('turn/completed', { turn: { id: turnId } })
    await host.flushStreamedEvents(sessionId)
  }
}

/** A turn the person started that is still running; resolves to its end. */
export async function runningUserTurn(
  chat: FakeConnection,
  sessionId = COORDINATOR
): Promise<() => Promise<void>> {
  expect(await sendUserMessage(sessionId, 'go')).toMatchObject({ ok: true })
  return runningTurn(chat, 0, sessionId)
}

/** The ids of the cards the chat lists in its queue. */
export async function queuedCardIds(sessionId = COORDINATOR): Promise<string[]> {
  const page = await host.history({ sessionId, direction: 'tail' })
  return page.ok ? (page.page.queuedMessages ?? []).map((card) => card.messageId) : []
}

/** The person's Delete on a card, as the chat surface sends it. */
export function deleteCard(messageId: string, sessionId = COORDINATOR) {
  return host.queuedMessageDelete(
    { callerKey: 'test-surface' },
    {
      envelope: {
        sessionId,
        clientOperationId: operationId(),
        expectedRuntimeFence: host.deps.store.getRecord(sessionId)!.lease.runtimeFence,
        payloadFingerprint: computeAgentSessionPayloadFingerprint({
          method: 'agentSession.queuedMessageDelete',
          sessionId,
          fields: { messageId }
        })
      },
      messageId
    }
  )
}
