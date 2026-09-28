// Edit (withdraw-to-composer) for one queued draft, and the reload replay that
// finishes any Stop/Edit whose restoration a crash or reload cut short. Both
// answer from the host's op-stamped tombstone receipts, so one operation id is
// one withdrawal and one restoration, however many times it is asked.

import type {
  AgentSessionCancelResult,
  AgentSessionQueuedMessageDeleteResult
} from '../../../src/shared/agent-session-wire'
import type { RpcClient } from '../transport/rpc-client'
import { requestStructuredAgentSessionMutation } from './mobile-structured-agent-session-rpc'
import { queuedMessageBodyText } from './mobile-structured-queued-message-cards'
import {
  discardQueuedRestoreOperation,
  getOrCreateQueuedRestoreOperation,
  listQueuedRestoreOperations,
  queuedRestoreEntryKey,
  settleQueuedRestoreOperation,
  type QueuedRestoreEntry
} from './mobile-structured-queued-restore-journal'
import { structuredSessionOperationId } from './structured-session-operation-id'

export type QueuedRestoreTextSink = (draftKey: string, text: string) => void

/**
 * Edit = Delete + the returned body into the composer. The operation identity is
 * persisted before the RPC so the reclaimed text survives a reload between the
 * host's withdrawal and the composer write.
 */
export async function editMobileQueuedMessage(input: {
  client: RpcClient
  sessionId: string
  sessionKey: string
  expectedRuntimeFence: number
  messageId: string
  draftKey: string
  appendText: QueuedRestoreTextSink
  onSendError: (message: string) => void
}): Promise<boolean> {
  const fields = { messageId: input.messageId }
  const entryKey = queuedRestoreEntryKey({
    sessionKey: input.sessionKey,
    method: 'agentSession.queuedMessageDelete',
    fields
  })
  let handle: { entryKey: string; operationId: string } | null = null
  try {
    const operation = await getOrCreateQueuedRestoreOperation({
      entryKey,
      sessionId: input.sessionId,
      sessionKey: input.sessionKey,
      draftKey: input.draftKey,
      method: 'agentSession.queuedMessageDelete',
      fields,
      createOperationId: structuredSessionOperationId
    })
    handle = { entryKey, operationId: operation.operationId }
  } catch {
    handle = null
  }
  const result = await requestStructuredAgentSessionMutation<AgentSessionQueuedMessageDeleteResult>(
    {
      client: input.client,
      method: 'agentSession.queuedMessageDelete',
      fingerprintMethod: 'agentSession.queuedMessageDelete',
      sessionId: input.sessionId,
      expectedRuntimeFence: input.expectedRuntimeFence,
      fields,
      clientOperationId: handle?.operationId ?? structuredSessionOperationId()
    }
  )
  if (result.status === 'accepted') {
    const value = result.value
    if (value.deleted) {
      const apply = (): void => input.appendText(input.draftKey, queuedMessageBodyText(value.body))
      if (handle) {
        await settleQueuedRestoreOperation({ ...handle, restore: apply }).catch(apply)
      } else {
        apply()
      }
      return true
    }
    if (handle) {
      await discardQueuedRestoreOperation(handle).catch(() => undefined)
    }
    if (value.disposition === 'dispatched') {
      input.onSendError('This message was already sent.')
    }
    return false
  }
  if (handle && result.status !== 'unknown') {
    await discardQueuedRestoreOperation(handle).catch(() => undefined)
  }
  if (result.status === 'refused' || result.status === 'failed') {
    input.onSendError(result.message)
  }
  return false
}

function replayFields(entry: QueuedRestoreEntry): Record<string, unknown> {
  // A persisted cancel entry is always a withdrawing Stop; the flag is not
  // stored because it is implied, but the wire fields must match the original.
  return entry.method === 'agentSession.cancel'
    ? { turnId: entry.fields.turnId, withdrawQueued: true }
    : { messageId: entry.fields.messageId }
}

/**
 * Finish restorations a reload interrupted: reissue each persisted operation
 * under its recorded id and settle the composer text from the replayed answer.
 * Safe against new work — a cancel names its recorded turn, so a late first run
 * can only stop the turn the user originally stopped, and a delete names its
 * draft. Transport doubt leaves the entry for the next open; a definite answer
 * without owed text discards it.
 */
export async function replayQueuedRestoreOperations(input: {
  client: RpcClient
  sessionId: string
  sessionKey: string
  expectedRuntimeFence: number
  appendText: QueuedRestoreTextSink
}): Promise<void> {
  const entries = await listQueuedRestoreOperations({ sessionKey: input.sessionKey }).catch(
    () => [] as QueuedRestoreEntry[]
  )
  for (const entry of entries) {
    if (entry.sessionId !== input.sessionId) {
      continue
    }
    const request = { ...input, entry }
    if (entry.method === 'agentSession.cancel') {
      await replayOne<AgentSessionCancelResult>(request, (value) =>
        (value.withdrawnQueued ?? []).map((withdrawn) => queuedMessageBodyText(withdrawn.body))
      )
    } else {
      await replayOne<AgentSessionQueuedMessageDeleteResult>(request, (value) =>
        value.deleted ? [queuedMessageBodyText(value.body)] : []
      )
    }
  }
}

async function replayOne<TValue>(
  input: {
    client: RpcClient
    sessionId: string
    expectedRuntimeFence: number
    appendText: QueuedRestoreTextSink
    entry: QueuedRestoreEntry
  },
  owedTexts: (value: TValue) => string[]
): Promise<void> {
  const { entry } = input
  const result = await requestStructuredAgentSessionMutation<TValue>({
    client: input.client,
    method: entry.method,
    fingerprintMethod: entry.method,
    sessionId: input.sessionId,
    expectedRuntimeFence: input.expectedRuntimeFence,
    fields: replayFields(entry),
    clientOperationId: entry.operationId
  })
  if (result.status === 'accepted') {
    const texts = owedTexts(result.value)
    await settleQueuedRestoreOperation({
      entryKey: entry.entryKey,
      operationId: entry.operationId,
      restore: () => {
        for (const text of texts) {
          input.appendText(entry.draftKey, text)
        }
      }
    }).catch(() => undefined)
    return
  }
  if (result.status !== 'unknown') {
    await discardQueuedRestoreOperation({
      entryKey: entry.entryKey,
      operationId: entry.operationId
    }).catch(() => undefined)
  }
}
